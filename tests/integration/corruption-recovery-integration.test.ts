import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseManager } from '../../src/store/db.js';
import { isFts5QueryError } from '../../src/store/fts-query.js';
import { reconcileMarkdownMemoryScope } from '../../src/store/sqlite-memory-store.js';

/**
 * Behavior change under test (PR #184): reconcileMarkdownMemoryScope now
 * runs its persistence inside DatabaseManager.withCorruptionRecovery().
 * Before this change, corruption errors ("database disk image is malformed",
 * SQLITE_CORRUPT, SQLITE_NOTADB) thrown during markdown reconciliation
 * surfaced as raw failures on every memory write — corruption recovery was
 * only wired into the session-indexing paths, so a corrupt sessions.db kept
 * failing markdown syncs until repaired by hand. Now the markdown reconcile
 * path participates in the same recovery: the corrupt database is
 * quarantined, rebuilt, and the reconcile is retried on a fresh handle, so
 * the memory entry is persisted instead of lost.
 *
 * The FTS5 soft fallback stays narrow: only genuine FTS query/index errors
 * (isFts5QueryError) degrade to a warned, repair-guided result. Corruption
 * signals never match that classifier, so they can never be swallowed into a
 * zero-count success here.
 */
describe('Corruption recovery during markdown sync', () => {
  it('keeps corruption signals out of the FTS5 fallback classifier', () => {
    // Corruption/recovery signals must propagate so DatabaseManager can
    // quarantine + rebuild, not be swallowed by the search-index fallback.
    assert.equal(isFts5QueryError(new Error('database disk image is malformed')), false);
    assert.equal(isFts5QueryError(new Error('SQL logic error')), false);
    assert.equal(isFts5QueryError(new Error('file is not a database')), false);
    // Genuine FTS5 query/index errors remain recoverable search-path failures.
    assert.equal(isFts5QueryError(new Error('fts5: syntax error near "AND"')), true);
    assert.equal(isFts5QueryError(new Error('fts5: unterminated string')), true);
  });

  it('withCorruptionRecovery quarantines a corrupt DB, rebuilds, and persists the entry', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-corruption-'));
    const dbManager = new DatabaseManager(tmpDir);
    const dbFile = path.join(tmpDir, 'sessions.db');

    try {
      // 1. Prime a healthy database with one memory.
      const first = reconcileMarkdownMemoryScope(dbManager, ['first healthy entry'], 'memory', null);
      assert.equal(first.inserted, 1);
      await dbManager.waitForStartupIntegrityScan();

      // 2. Close the handle and corrupt the DB file on disk.
      dbManager.close();
      fs.writeFileSync(dbFile, 'GARBAGE-NOT-A-SQLITE-DB'.repeat(32), 'utf-8');
      assert.equal(isFts5QueryError(new Error('file is not a database')), false);

      // 3. Reconcile a second entry. The corrupt file must be detected,
      // quarantined, and a fresh database rebuilt — and the entry persisted
      // on the healthy database instead of being swallowed as a zero-count
      // "successful" reconcile.
      const second = reconcileMarkdownMemoryScope(dbManager, ['second entry after corruption'], 'memory', null);

      // 4. Recovery must have run (not a no-op reuse of the corrupt file).
      const recovery = dbManager.getLastRecovery();
      assert.ok(recovery, 'expected a corruption recovery to be recorded');
      assert.notEqual(recovery.strategy, 'reused', 'the corrupt file must not have been reused');
      assert.ok(recovery.backupPaths.length >= 1, 'the corrupt file must have been quarantined to a backup');
      for (const backup of recovery.backupPaths) {
        assert.ok(fs.existsSync(backup), `quarantined backup missing: ${backup}`);
      }

      // 5. The entry must actually be persisted in the rebuilt database —
      // a swallowed zero-count success would leave the memory in markdown only.
      assert.ok(second.inserted >= 1, `expected the entry to persist after recovery, got ${JSON.stringify(second)}`);
      const rows = dbManager.getDb()
        .prepare('SELECT content FROM memories WHERE target = ? ORDER BY id ASC')
        .all('memory') as Array<{ content: string }>;
      assert.ok(
        rows.some((row) => row.content.includes('second entry after corruption')),
        'the second entry must be present in the rebuilt database',
      );

      // 6. The original path must now hold a fresh, healthy database.
      const header = fs.readFileSync(dbFile).subarray(0, 16).toString('utf-8');
      assert.equal(header, 'SQLite format 3\x00', 'a fresh SQLite database must exist at the original path');
    } finally {
      try { dbManager.close(); } catch { /* best effort */ }
      // Best-effort: on Windows the shared AtomicLockCoordinator keeps
      // .pi-hermes-locks.sqlite open, so the directory may not be removable.
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* OS cleans temp eventually */ }
    }
  });
});
