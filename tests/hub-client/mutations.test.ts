/**
 * Shared-mutation procedure tests with a stub client (VG-3, BH-6):
 * the partial-failure states of the add-first replace procedure —
 * both the unreachable class AND the http-error class (a 500 on the
 * remove must also name the surviving old id), plus the hash-equal
 * category-identity contract (EC-3).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sharedReplace,
  sharedRemove,
  type SharedMutationTarget,
} from '../../src/hub-client/mutations.js';
import { HubHttpError, HubUnreachableError } from '../../src/hub-client/client.js';
import { deterministicEntryId } from '../../src/shared/content-id.js';
import type { SearchHit } from '../../src/shared/wire.js';

interface StubBehavior {
  searchHits?: SearchHit[];
  onAdd?: (op: unknown) => Record<string, unknown>;
  onRemove?: (id: string) => void;
}

function stubTarget(behavior: StubBehavior): SharedMutationTarget {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = {
    search: async () => behavior.searchHits ?? [],
    memory: async (op: { op: string; id?: string }) => {
      if (op.op === 'add') return behavior.onAdd ? behavior.onAdd(op) : { action: 'inserted', entry: { id: op.id } };
      if (op.op === 'remove') { behavior.onRemove?.(op.id!); return { removed: true }; }
      throw new Error(`unexpected op ${op.op}`);
    },
  };
  return {
    client: client as SharedMutationTarget['client'],
    sessionId: 'sess-test',
    scope: 'memory',
  };
}

function hit(content: string, category?: string): SearchHit {
  const id = deterministicEntryId(content, 'memory', null, category ?? null);
  return {
    id,
    content,
    project: undefined,
    scope: 'memory',
    category,
    failureReason: undefined,
    toolState: undefined,
    correctedTo: undefined,
    machine: 'box-a',
    session: 'sess-a',
    identity: 'box-a',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    provenance: [{ machine: 'box-a', session: 'sess-a', at: '2026-01-01T00:00:00.000Z' }],
    source: 'shared',
  } as unknown as SearchHit;
}

describe('sharedReplace partial failure (VG-3)', () => {
  it('remove throws HubHttpError (500) AFTER the add landed → the surviving old id is named', async () => {
    const oldContent = 'the old value of a knob';
    const target = stubTarget({
      searchHits: [hit(oldContent)],
      onAdd: (op) => {
        assert.equal((op as { inherits_from?: string }).inherits_from, hit(oldContent).id);
        return { action: 'inserted', entry: { id: (op as { id: string }).id } };
      },
      onRemove: () => {
        throw new HubHttpError(500, 'internal_error', 'hub exploded mid-remove');
      },
    });
    const outcome = await sharedReplace(target, oldContent, 'the new value of a knob');
    assert.equal(outcome.failed, true);
    assert.match(outcome.error ?? '', /hub exploded mid-remove/);
    assert.equal(outcome.replaced, 0);
    // The add LANDED before the remove failed → the old id is actionable
    // cleanup and must be named (BH-6: ANY post-add failure, not only
    // unreachable):
    assert.deepEqual(outcome.leftoverOldIds, [hit(oldContent).id]);
  });

  it('remove throws HubUnreachableError after the add landed → the old id is named too', async () => {
    const oldContent = 'flaky network fact';
    const target = stubTarget({
      searchHits: [hit(oldContent)],
      onRemove: () => { throw new HubUnreachableError('connection reset'); },
    });
    const outcome = await sharedReplace(target, oldContent, 'flaky network fact v2');
    assert.equal(outcome.failed, true);
    assert.deepEqual(outcome.leftoverOldIds, [hit(oldContent).id]);
  });

  it('the SEARCH step failing (no matches found) → clean not-found, no leftovers', async () => {
    const target = stubTarget({ searchHits: [] });
    const outcome = await sharedReplace(target, 'matches nothing anywhere', 'new');
    assert.equal(outcome.failed, false);
    assert.equal(outcome.replaced, 0);
    assert.deepEqual(outcome.leftoverOldIds, []);
  });
});

describe('sharedReplace category identity (EC-3)', () => {
  it('replacing a non-failure-category hit writes the HIT category, not the target default', async () => {
    const oldContent = 'a correction-category fact';
    const written: Array<{ id?: string; category?: string; inherits_from?: string }> = [];
    const target = stubTarget({
      searchHits: [hit(oldContent, 'correction')],
      onAdd: (op) => { written.push(op as never); return { action: 'inserted' }; },
    });
    // Simulate the failure target (category default 'failure') replacing a
    // 'correction' entry — the stored category must follow the hit:
    (target as { category?: string }).category = 'failure';
    const outcome = await sharedReplace(target, oldContent, 'a corrected fact v2');
    assert.equal(outcome.replaced, 1);
    assert.equal(written.length, 1);
    assert.equal(written[0].category, 'correction', 'the hit category travels with the entry');
    // And the written id must hash with that same category — one identity:
    const expectedId = deterministicEntryId('a corrected fact v2', 'memory', null, 'correction');
    assert.equal(written[0].id, expectedId);
  });

  it('identical content with a category: pure upsert under the hit category (no duplicate)', async () => {
    const content = 'unchanged correction fact';
    const written: Array<{ id?: string; category?: string }> = [];
    const target = stubTarget({
      searchHits: [hit(content, 'correction')],
      onAdd: (op) => { written.push(op as never); return { action: 'kept' }; },
    });
    (target as { category?: string }).category = 'failure';
    const outcome = await sharedReplace(target, content, content);
    assert.equal(outcome.unchanged, 1);
    assert.equal(outcome.replaced, 0);
    assert.equal(written[0].category, 'correction');
    assert.equal(written[0].id, deterministicEntryId(content, 'memory', null, 'correction'));
  });
});

describe('sharedRemove idempotency (BH-11)', () => {
  it('removes every match; a remove error fails the procedure explicitly', async () => {
    const target = stubTarget({
      searchHits: [hit('dupe one'), hit('dupe two')],
    });
    const outcome = await sharedRemove(target, 'dupe');
    assert.equal(outcome.removed, 2);
    assert.equal(outcome.failed, false);
  });

  it('a failing remove reports the error (no silent success)', async () => {
    const target = stubTarget({
      searchHits: [hit('dupe one')],
      onRemove: () => { throw new HubHttpError(500, 'boom', 'remove failed'); },
    });
    const outcome = await sharedRemove(target, 'dupe');
    assert.equal(outcome.failed, true);
    assert.match(outcome.error ?? '', /remove failed/);
  });
});
