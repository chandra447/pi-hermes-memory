import { afterEach, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { addMemory, getMemoryUsageSignals } from '../../src/store/sqlite-memory-store.js';
import { normalizeMemoryLookupText } from '../../src/store/memory-lookup.js';
import { registerMemorySearchTool } from '../../src/tools/memory-search-tool.js';

let ROOT_DIR = '';

afterEach(() => {
  if (ROOT_DIR) fs.rmSync(ROOT_DIR, { recursive: true, force: true });
  ROOT_DIR = '';
});

function makeDbManager(): DatabaseManager {
  ROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-search-tool-test-'));
  return new DatabaseManager(ROOT_DIR);
}

describe('registerMemorySearchTool', () => {
  it('returns a broader natural-language match when strict term matching misses', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, "user's name is Naruto", 'user');

    let captured: any;
    const mockPi = {
      registerTool: (def: any) => {
        captured = def;
      },
    } as any;

    registerMemorySearchTool(mockPi, dbManager);

    const result = await captured.execute('tc-1', { query: 'name identity Naruto', target: 'user' });

    assert.strictEqual(result.details.success, true);
    assert.strictEqual(result.details.count, 1);
    assert.match(result.content[0].text, /Naruto/);

    dbManager.close();
  });

  it('labels every result with its mutation target and unambiguous scope', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, 'global deployment convention');
    addMemory(dbManager, 'user deployment preference', 'user');
    addMemory(dbManager, 'failure deployment lesson', 'failure');
    addMemory(dbManager, 'project deployment convention', 'memory', 'project-a');
    addMemory(dbManager, 'project failure deployment lesson', 'failure', 'project-a');

    let captured: any;
    registerMemorySearchTool({ registerTool: (def: any) => { captured = def; } } as any, dbManager);

    const result = await captured.execute('tc-1', { query: 'deployment' });
    const text = result.content[0].text;

    assert.match(text, /scope=global \[target=memory\] global deployment convention/);
    assert.match(text, /scope=global \[target=user\] user deployment preference/);
    assert.match(text, /scope=global \[target=failure\] failure deployment lesson/);
    assert.match(text, /scope=project:project-a \[target=project\] project deployment convention/);
    assert.match(text, /scope=project:project-a \[target=failure\] project failure deployment lesson/);

    dbManager.close();
  });

  it('accepts target "project" as a filter and shows the schema value', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, 'project deployment convention', 'memory', 'project-a');
    addMemory(dbManager, 'global deployment convention');
    addMemory(dbManager, 'project failure deployment lesson', 'failure', 'project-a');

    let captured: any;
    registerMemorySearchTool({ registerTool: (def: any) => { captured = def; } } as any, dbManager);

    assert.ok(captured.parameters.properties.target.enum.includes('project'));

    const result = await captured.execute('tc-1', { query: 'deployment', target: 'project' });
    const text = result.content[0].text;

    assert.strictEqual(result.details.success, true);
    assert.strictEqual(result.details.count, 1);
    assert.match(text, /scope=project:project-a \[target=project\]/);
    assert.doesNotMatch(text, /scope=global/);

    dbManager.close();
  });

  it('keeps copied results reversible when a project name contains brackets', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, 'literal project entry', 'memory', 'foo] bar');

    let captured: any;
    registerMemorySearchTool({ registerTool: (def: any) => { captured = def; } } as any, dbManager);

    const result = await captured.execute('tc-1', { query: 'literal' });
    const firstResultLine = result.content[0].text.split('\n').find((line: string) => line.startsWith('🧠'))!;

    assert.match(firstResultLine, /scope=project:foo%5D%20bar \[target=project\]/);
    assert.equal(normalizeMemoryLookupText(firstResultLine), 'literal project entry');

    dbManager.close();
  });

  it('records a usage hit for every returned entry', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, 'recallable volcano note', 'memory');
    addMemory(dbManager, 'recallable tide note', 'memory');

    let captured: any;
    registerMemorySearchTool({ registerTool: (def: any) => { captured = def; } } as any, dbManager);

    await captured.execute('tc-1', { query: 'recallable' });
    await captured.execute('tc-2', { query: 'volcano' });

    const signals = getMemoryUsageSignals(dbManager, { target: 'memory', project: null });
    assert.strictEqual(signals.get('recallable volcano note')?.hits, 2);
    assert.strictEqual(signals.get('recallable tide note')?.hits, 1);

    dbManager.close();
  });

  it('records nothing when the search returns no results', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, 'unmatched entry', 'memory');

    let captured: any;
    registerMemorySearchTool({ registerTool: (def: any) => { captured = def; } } as any, dbManager);

    const result = await captured.execute('tc-1', { query: 'zzz-no-match-q' });
    assert.strictEqual(result.details.count, 0);
    assert.strictEqual(getMemoryUsageSignals(dbManager, { target: 'memory', project: null }).size, 0);

    dbManager.close();
  });

  it('skips recording when usage tracking is disabled', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, 'tracked-off entry', 'memory');

    let captured: any;
    registerMemorySearchTool(
      { registerTool: (def: any) => { captured = def; } } as any,
      dbManager,
      { usageTrackingEnabled: false },
    );

    const result = await captured.execute('tc-1', { query: 'tracked-off' });
    assert.strictEqual(result.details.count, 1);
    assert.strictEqual(getMemoryUsageSignals(dbManager, { target: 'memory', project: null }).size, 0);

    dbManager.close();
  });

  it('never breaks the search when hit recording fails (fail-open)', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, 'resilient entry', 'memory');

    let getDbCalls = 0;
    const realGetDb = dbManager.getDb.bind(dbManager);
    const flaky = Object.create(dbManager) as DatabaseManager;
    flaky.getDb = () => {
      getDbCalls++;
      if (getDbCalls > 2) throw new Error('injected recording failure');
      return realGetDb();
    };

    let captured: any;
    registerMemorySearchTool({ registerTool: (def: any) => { captured = def; } } as any, flaky);

    // getDb calls: getMemoryStats(1) + searchMemories(1) + recordSearchHits(1, throws).
    const result = await captured.execute('tc-1', { query: 'resilient' });
    assert.strictEqual(result.details.success, true);
    assert.strictEqual(result.details.count, 1);
    assert.match(result.content[0].text, /resilient entry/);
    // The hit did NOT land (recording failed) but the search succeeded.
    assert.strictEqual(getMemoryUsageSignals(dbManager, { target: 'memory', project: null }).size, 0);

    dbManager.close();
  });
});
