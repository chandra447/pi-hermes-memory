import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { DatabaseManager } from '../../src/store/db.js';
import { registerMemoryTool } from '../../src/tools/memory-tool.js';
import {
  migrateThenSyncMarkdownMemories,
  registerSyncMarkdownMemoriesCommand,
  syncMarkdownMemoriesToSqlite,
} from '../../src/handlers/sync-markdown-memories.js';
import { ENTRY_DELIMITER } from '../../src/constants.js';
import { addMemory, getMemories, searchMemories } from '../../src/store/sqlite-memory-store.js';
import { AtomicLockCoordinator } from '../../src/store/atomic-lock-coordinator.js';

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

    registerSyncMarkdownMemoriesCommand(mockPi, dbManager, globalDir, undefined, agentRoot);

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

    registerSyncMarkdownMemoriesCommand(mockPi, dbManager, globalDir, undefined, agentRoot);
    await handler({}, ctx);

    const projectRows = getMemories(dbManager, { project: 'legacy-project', target: 'memory' });
    assert.strictEqual(projectRows.length, 1);
    assert.strictEqual(projectRows[0].content, 'legacy project entry');
  });

  it('makes new-layout project markdown searchable when startup sync runs', async () => {
    const projectDir = path.join(agentRoot, 'projects-memory', 'latest-project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'MEMORY.md'),
      'latest path searchable entry <!-- created=2026-05-11, last=2026-05-11 -->',
      'utf-8',
    );

    const counters = await syncMarkdownMemoriesToSqlite(dbManager, globalDir, undefined, agentRoot);

    assert.strictEqual(counters.projectCount, 1);
    assert.strictEqual(counters.imported, 1);

    const results = searchMemories(dbManager, 'latest path searchable entry', {
      project: 'latest-project',
      target: 'memory',
    });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].content, 'latest path searchable entry');
  });

  it('prunes Markdown orphans while preserving other targets and projects', async () => {
    fs.writeFileSync(path.join(globalDir, 'MEMORY.md'), 'kept global memory', 'utf-8');
    fs.writeFileSync(path.join(globalDir, 'USER.md'), 'kept global user', 'utf-8');
    const projectDir = path.join(agentRoot, 'projects-memory', 'project-a');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'MEMORY.md'), 'kept project memory', 'utf-8');

    await syncMarkdownMemoriesToSqlite(dbManager, globalDir, undefined, agentRoot);
    dbManager.getDb().prepare(`
      INSERT INTO memories (project, target, category, content, created, last_referenced)
      VALUES (NULL, 'memory', NULL, 'orphaned global memory', '2026-07-01', '2026-07-01')
    `).run();

    const counters = await syncMarkdownMemoriesToSqlite(dbManager, globalDir, undefined, agentRoot);

    assert.strictEqual(counters.removed, 1);
    assert.deepStrictEqual(
      getMemories(dbManager).map((entry) => `${entry.project ?? 'global'}:${entry.target}:${entry.content}`).sort(),
      [
        'global:memory:kept global memory',
        'global:user:kept global user',
        'project-a:memory:kept project memory',
      ].sort(),
    );
  });

  it('waits for the canonical Markdown mutation before reading and reconciling', async () => {
    const memoryFile = path.join(globalDir, 'MEMORY.md');
    fs.writeFileSync(memoryFile, 'stale memory', 'utf-8');
    addMemory(dbManager, 'stale memory');

    const identity = fs.realpathSync(memoryFile);
    const coordinator = new AtomicLockCoordinator(path.join(path.dirname(path.dirname(identity)), '.pi-hermes-locks.sqlite'));
    const lease = coordinator.tryAcquire(`mutation:${identity}`, { staleMs: 300_000 });
    assert.ok(lease);

    let settled = false;
    const syncing = Promise.resolve()
      .then(() => syncMarkdownMemoriesToSqlite(dbManager, globalDir, undefined, agentRoot))
      .then((result) => {
        settled = true;
        return result;
      });

    await new Promise<void>((resolve) => setImmediate(resolve));
    const waitedForMutation = !settled;
    fs.writeFileSync(memoryFile, ['stale memory', 'newer writer memory'].join(ENTRY_DELIMITER), 'utf-8');
    addMemory(dbManager, 'newer writer memory');
    lease.release();
    await syncing;

    assert.ok(waitedForMutation, 'reconciliation must wait for the active Markdown mutation');
    assert.deepStrictEqual(
      getMemories(dbManager, { target: 'memory', project: null }).map((entry) => entry.content).sort(),
      ['newer writer memory', 'stale memory'],
    );
  });

  it('prunes a deleted project Markdown scope without touching unrelated rows', async () => {
    const deletedProjectDir = path.join(agentRoot, 'projects-memory', 'deleted-project');
    const keptProjectDir = path.join(agentRoot, 'projects-memory', 'kept-project');
    fs.mkdirSync(deletedProjectDir, { recursive: true });
    fs.mkdirSync(keptProjectDir, { recursive: true });
    fs.writeFileSync(path.join(deletedProjectDir, 'MEMORY.md'), 'deleted project memory', 'utf-8');
    fs.writeFileSync(path.join(keptProjectDir, 'MEMORY.md'), 'kept project memory', 'utf-8');
    fs.writeFileSync(path.join(globalDir, 'MEMORY.md'), 'kept global memory', 'utf-8');

    await syncMarkdownMemoriesToSqlite(dbManager, globalDir, undefined, agentRoot);
    dbManager.getDb().prepare(`
      INSERT INTO memories (project, target, category, content, created, last_referenced)
      VALUES ('deleted-project', 'user', NULL, 'unrelated project user', '2026-07-01', '2026-07-01')
    `).run();
    fs.rmSync(deletedProjectDir, { recursive: true });

    const counters = await syncMarkdownMemoriesToSqlite(dbManager, globalDir, undefined, agentRoot);

    assert.strictEqual(counters.removed, 1);
    assert.ok(!fs.existsSync(deletedProjectDir));
    assert.deepStrictEqual(
      getMemories(dbManager).map((entry) => `${entry.project ?? 'global'}:${entry.target}:${entry.content}`).sort(),
      [
        'deleted-project:user:unrelated project user',
        'global:memory:kept global memory',
        'kept-project:memory:kept project memory',
      ],
    );
  });

  it('treats a missing canonical project file as empty despite a retained legacy backup', async () => {
    const projectName = 'canonical-deleted-project';
    const canonicalProjectDir = path.join(agentRoot, 'projects-memory', projectName);
    const legacyProjectDir = path.join(agentRoot, projectName);
    fs.mkdirSync(canonicalProjectDir, { recursive: true });
    fs.mkdirSync(legacyProjectDir, { recursive: true });
    fs.writeFileSync(path.join(legacyProjectDir, 'MEMORY.md'), 'retained legacy backup', 'utf-8');
    addMemory(dbManager, 'stale canonical row', 'memory', projectName);

    const counters = await syncMarkdownMemoriesToSqlite(dbManager, globalDir, undefined, agentRoot);

    assert.strictEqual(counters.removed, 1);
    assert.deepStrictEqual(getMemories(dbManager, { project: projectName, target: 'memory' }), []);
    assert.strictEqual(
      fs.readFileSync(path.join(legacyProjectDir, 'MEMORY.md'), 'utf-8'),
      'retained legacy backup',
    );
  });

  it('reconciles unsafe SQLite project scopes empty without reading outside projects-memory', async () => {
    const outsideDir = path.join(agentRoot, 'outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'MEMORY.md'), 'outside traversal bait', 'utf-8');
    addMemory(dbManager, 'outside traversal bait', 'memory', '../outside');

    const counters = await syncMarkdownMemoriesToSqlite(dbManager, globalDir, undefined, agentRoot);

    assert.strictEqual(counters.removed, 1);
    assert.deepStrictEqual(getMemories(dbManager, { project: '../outside', target: 'memory' }), []);
    assert.strictEqual(fs.readFileSync(path.join(outsideDir, 'MEMORY.md'), 'utf-8'), 'outside traversal bait');
  });

  it('reconciles a symlinked project directory empty without reading its target', async (t) => {
    const outsideDir = path.join(tmpDir, 'outside-project');
    const projectLink = path.join(agentRoot, 'projects-memory', 'linked-project');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.mkdirSync(path.dirname(projectLink), { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'MEMORY.md'), 'outside directory bait', 'utf-8');
    try {
      fs.symlinkSync(outsideDir, projectLink, 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('directory symlinks unavailable');
      throw error;
    }
    addMemory(dbManager, 'stale linked project row', 'memory', 'linked-project');

    const counters = await syncMarkdownMemoriesToSqlite(dbManager, globalDir, undefined, agentRoot);

    assert.strictEqual(counters.removed, 1);
    assert.deepStrictEqual(getMemories(dbManager, { project: 'linked-project', target: 'memory' }), []);
  });

  it('reconciles a symlinked project memory file empty without reading its target', async (t) => {
    const outsideFile = path.join(tmpDir, 'outside-memory.md');
    const projectDir = path.join(agentRoot, 'projects-memory', 'linked-file-project');
    const memoryLink = path.join(projectDir, 'MEMORY.md');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(outsideFile, 'outside file bait', 'utf-8');
    try {
      fs.symlinkSync(outsideFile, memoryLink, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('file symlinks unavailable');
      throw error;
    }
    addMemory(dbManager, 'stale linked file row', 'memory', 'linked-file-project');

    const counters = await syncMarkdownMemoriesToSqlite(dbManager, globalDir, undefined, agentRoot);

    assert.strictEqual(counters.removed, 1);
    assert.deepStrictEqual(getMemories(dbManager, { project: 'linked-file-project', target: 'memory' }), []);
  });

  it('still scans project markdown under ~/.pi/agent when memoryDir is customized elsewhere', async () => {
    const customGlobalDir = path.join(tmpDir, 'external-memory-root');
    fs.mkdirSync(customGlobalDir, { recursive: true });

    const customDbManager = new DatabaseManager(customGlobalDir);
    try {
      const projectDir = path.join(agentRoot, 'projects-memory', 'custom-root-project');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, 'MEMORY.md'),
        'custom root project entry <!-- created=2026-05-11, last=2026-05-11 -->',
        'utf-8',
      );

      const counters = await syncMarkdownMemoriesToSqlite(customDbManager, customGlobalDir, undefined, agentRoot);

      assert.strictEqual(counters.projectCount, 1);
      const results = searchMemories(customDbManager, 'custom root project entry', {
        project: 'custom-root-project',
        target: 'memory',
      });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].content, 'custom root project entry');
    } finally {
      customDbManager.close();
    }
  });

  it('migrates a populated legacy database before startup reconciliation', async () => {
    dbManager.close();
    const legacyDir = path.join(agentRoot, 'memory');
    const targetDir = path.join(agentRoot, 'pi-hermes-memory');
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyManager = new DatabaseManager(legacyDir);
    legacyManager.getDb().prepare(`
      INSERT INTO sessions (id, project, cwd, started_at, ended_at, message_count)
      VALUES ('legacy-session', 'legacy-project', '/legacy/project', '2026-07-01', NULL, 1)
    `).run();
    legacyManager.close();

    const targetManager = new DatabaseManager(targetDir);
    try {
      await migrateThenSyncMarkdownMemories(targetManager, legacyDir, targetDir, undefined, agentRoot);

      const sessions = targetManager.getDb().prepare('SELECT id FROM sessions').all() as Array<{ id: string }>;
      assert.deepStrictEqual(sessions.map((session) => session.id), ['legacy-session']);
    } finally {
      targetManager.close();
    }
  });

  it('does not create a destination database after critical migration failure', async () => {
    dbManager.close();
    const legacyDir = path.join(agentRoot, 'memory');
    const targetDir = path.join(agentRoot, 'pi-hermes-memory');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'sessions.db'), 'populated legacy database', 'utf-8');
    const targetManager = new DatabaseManager(targetDir);
    let migrationSucceeded = false;

    try {
      await assert.rejects(
        migrateThenSyncMarkdownMemories(
          targetManager,
          legacyDir,
          targetDir,
          undefined,
          agentRoot,
          {
            moveFile: async () => {
              throw new Error('injected sessions.db move failure');
            },
            onMigrationSucceeded: () => {
              migrationSucceeded = true;
            },
          },
        ),
        /sessions\.db migration failed/,
      );
      assert.equal(fs.existsSync(path.join(targetDir, 'sessions.db')), false);
      assert.equal(fs.existsSync(path.join(legacyDir, 'sessions.db')), true);
      assert.equal(migrationSucceeded, false);
    } finally {
      targetManager.close();
    }
  });

  it('hands a corrupt legacy database to bounded destination recovery', async () => {
    dbManager.close();
    const legacyDir = path.join(agentRoot, 'memory');
    const targetDir = path.join(agentRoot, 'pi-hermes-memory');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'sessions.db'), 'not a sqlite database', 'utf-8');
    const targetManager = new DatabaseManager(targetDir);

    try {
      await migrateThenSyncMarkdownMemories(targetManager, legacyDir, targetDir, undefined, agentRoot);

      assert.equal(fs.existsSync(path.join(legacyDir, 'sessions.db')), false);
      assert.deepStrictEqual(targetManager.getDb().pragma?.('quick_check'), [{ quick_check: 'ok' }]);
      assert.equal(targetManager.getLastRecovery()?.strategy, 'recreated-empty');
      assert.ok(
        fs.readdirSync(targetDir).some((name) => name.startsWith('sessions.db.corrupt-')),
        'the corrupt generation should be quarantined by DatabaseManager',
      );
    } finally {
      targetManager.close();
    }
  });

  it('resolves a migrated file-symlink database at first I/O', { skip: process.platform === 'win32' }, async () => {
    dbManager.close();
    const legacyDir = path.join(agentRoot, 'memory');
    const targetDir = path.join(agentRoot, 'pi-hermes-memory');
    const realDir = path.join(tmpDir, 'real-database');
    const realDbPath = path.join(realDir, 'sessions.db');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(realDbPath, 'not a sqlite database');
    fs.symlinkSync(path.relative(legacyDir, realDbPath), path.join(legacyDir, 'sessions.db'), 'file');
    const targetManager = new DatabaseManager(targetDir);

    try {
      await migrateThenSyncMarkdownMemories(targetManager, legacyDir, targetDir, undefined, agentRoot);
      targetManager.getDb().prepare(
        "INSERT INTO extension_metadata (key, value) VALUES ('migrated-alias', 'kept')",
      ).run();
      targetManager.close();

      assert.equal(fs.lstatSync(path.join(targetDir, 'sessions.db')).isSymbolicLink(), true);
      const directManager = new DatabaseManager(realDir);
      try {
        assert.deepEqual(
          directManager.getDb().prepare(
            "SELECT value FROM extension_metadata WHERE key = 'migrated-alias'",
          ).get(),
          { value: 'kept' },
        );
      } finally {
        directManager.close();
      }
    } finally {
      targetManager.close();
    }
  });
});
