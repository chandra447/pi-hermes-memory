import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HubStore, mergeProvenance, parseProvenance, type EntryRow } from '../../src/hub/hub-store.js';
import { deterministicEntryId } from '../../src/shared/content-id.js';
import type { ProvenanceTouch } from '../../src/shared/wire.js';

let dir = '';

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function store(): HubStore {
  dir = mkdtempSync(path.join(tmpdir(), 'pi-provenance-'));
  return new HubStore(path.join(dir, 'shared.sqlite'));
}

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';
const T2 = '2026-01-03T00:00:00.000Z';

describe('mergeProvenance (set by machine, first-touch wins)', () => {
  it('keeps a machine\'s FIRST touch and appends new machines in at-order', () => {
    const list: ProvenanceTouch[] = [{ machine: 'a', session: 's1', at: T0 }];
    const withB = mergeProvenance(list, { machine: 'b', session: 's2', at: T1 });
    assert.deepEqual(withB, [
      { machine: 'a', session: 's1', at: T0 },
      { machine: 'b', session: 's2', at: T1 },
    ]);
    // Machine a touches again later: first touch wins (unchanged list).
    assert.deepEqual(mergeProvenance(withB, { machine: 'a', session: 's3', at: T2 }), withB);
  });

  it('orders by at (a late-arriving earlier touch sorts first)', () => {
    const list: ProvenanceTouch[] = [{ machine: 'b', session: 's2', at: T2 }];
    const merged = mergeProvenance(list, { machine: 'a', session: 's1', at: T0 });
    assert.deepEqual(
      merged.map((t) => t.machine),
      ['a', 'b'],
    );
  });
});

describe('hub provenance on upsert (story 2, Q1=B)', () => {
  it('insertion stamps a single-touch provenance list', () => {
    const s = store();
    const id = deterministicEntryId('fact one', 'memory', null, null);
    s.upsert({ id, content: 'fact one', scope: 'memory', machine: 'lincopta', identity: 'lincopta', session: 's1', created_at: T0, updated_at: T0 });
    const entry = s.getEntry(id)!;
    assert.deepEqual(entry.provenance, [{ machine: 'lincopta', session: 's1', at: T0 }]);
    s.close();
  });

  it('a re-add from ANOTHER box extends the list instead of overwriting (cross-box dedup)', () => {
    const s = store();
    const id = deterministicEntryId('shared fact', 'memory', null, null);
    s.upsert({ id, content: 'shared fact', scope: 'memory', machine: 'lincopta', identity: 'lincopta', session: 's1', created_at: T0, updated_at: T0 });
    const action = s.upsert({ id, content: 'shared fact', scope: 'memory', machine: 'peacewagon', identity: 'peacewagon', session: 's2', created_at: T1, updated_at: T1 });
    assert.equal(action, 'replaced');
    const entry = s.getEntry(id)!;
    assert.deepEqual(
      entry.provenance.map((t) => t.machine),
      ['lincopta', 'peacewagon'],
    );
    // Last-touch fields move to the newest writer.
    assert.equal(entry.machine, 'peacewagon');
    // Birth time is preserved.
    assert.equal(entry.created_at, T0);
    s.close();
  });

  it('the same machine re-adding does not duplicate itself', () => {
    const s = store();
    const id = deterministicEntryId('again', 'memory', null, null);
    s.upsert({ id, content: 'again', scope: 'memory', machine: 'a', identity: 'a', session: 's1', created_at: T0, updated_at: T0 });
    s.upsert({ id, content: 'again', scope: 'memory', machine: 'a', identity: 'a', session: 's2', created_at: T1, updated_at: T1 });
    assert.equal(s.getEntry(id)!.provenance.length, 1);
    s.close();
  });

  it('inherits_from seeds the new entry with the old entry\'s contributors', () => {
    const s = store();
    const oldId = deterministicEntryId('version one', 'memory', null, null);
    const newId = deterministicEntryId('version two', 'memory', null, null);
    s.upsert({ id: oldId, content: 'version one', scope: 'memory', machine: 'lincopta', identity: 'lincopta', session: 's1', created_at: T0, updated_at: T0 });
    s.upsert({ id: newId, content: 'version two', scope: 'memory', machine: 'cyberkleiber', identity: 'cyberkleiber', session: 's2', created_at: T1, updated_at: T1, inherits_from: oldId });
    const entry = s.getEntry(newId)!;
    assert.deepEqual(
      entry.provenance.map((t) => t.machine),
      ['lincopta', 'cyberkleiber'],
    );
    s.close();
  });

  it('inherits_from pointing at a gone entry seeds empty (concurrent remove)', () => {
    const s = store();
    const oldId = deterministicEntryId('gone', 'memory', null, null);
    const newId = deterministicEntryId('successor', 'memory', null, null);
    s.upsert({ id: oldId, content: 'gone', scope: 'memory', machine: 'a', identity: 'a', session: 's1', created_at: T0, updated_at: T0 });
    s.remove(oldId);
    s.upsert({ id: newId, content: 'successor', scope: 'memory', machine: 'b', identity: 'b', session: 's2', created_at: T1, updated_at: T1, inherits_from: oldId });
    assert.deepEqual(s.getEntry(newId)!.provenance, [{ machine: 'b', session: 's2', at: T1 }]);
    s.close();
  });

  it('an LWW-kept upsert from another machine still extends provenance (EC-4)', () => {
    // The content update is a no-op (existing is newer), BUT provenance is a
    // set-valued fact: the second machine wrote this content, so it belongs
    // in the contributor list even with equal/lagging clocks. Same id ⇒ same
    // content, so this is the cross-box dedup contract.
    const s = store();
    const id = deterministicEntryId('lww', 'memory', null, null);
    s.upsert({ id, content: 'lww', scope: 'memory', machine: 'a', identity: 'a', session: 's1', created_at: T1, updated_at: T1 });
    const action = s.upsert({ id, content: 'lww', scope: 'memory', machine: 'b', identity: 'b', session: 's2', created_at: T0, updated_at: T0 });
    assert.equal(action, 'kept');
    // Content LWW: the newer machine's row wins (machine 'a').
    assert.equal(s.getEntry(id)!.machine, 'a');
    // Provenance: BOTH machines are contributors now.
    const machines = s.getEntry(id)!.provenance.map((t) => t.machine).sort();
    assert.deepEqual(machines, ['a', 'b']);
    s.close();
  });

  it('an LWW-kept upsert from the SAME machine does not duplicate the touch', () => {
    const s = store();
    const id = deterministicEntryId('samebox', 'memory', null, null);
    s.upsert({ id, content: 'samebox', scope: 'memory', machine: 'a', identity: 'a', session: 's1', created_at: T1, updated_at: T1 });
    const action = s.upsert({ id, content: 'samebox', scope: 'memory', machine: 'a', identity: 'a', session: 's1', created_at: T0, updated_at: T0 });
    assert.equal(action, 'kept');
    assert.equal(s.getEntry(id)!.provenance.length, 1);
    s.close();
  });
});

describe('parseProvenance legacy/corrupt branches (direct — review fix)', () => {
  function row(provenance: string | null): EntryRow {
    return {
      id: 'x',
      project_key: null,
      scope: 'memory',
      category: null,
      kind: 'memory',
      state: null,
      content: 'c',
      failure_reason: null,
      tool_state: null,
      corrected_to: null,
      machine: 'oldbox',
      session: 'sess-0',
      identity: 'oldbox',
      created_at: T0,
      updated_at: T0,
      provenance,
    };
  }

  it('NULL (pre-story-2 row) backfills to the row\'s own single touch', () => {
    assert.deepEqual(parseProvenance(row(null)), [
      { machine: 'oldbox', session: 'sess-0', at: T0 },
    ]);
  });

  it('empty list ("[]") backfills to the row\'s own single touch', () => {
    assert.deepEqual(parseProvenance(row('[]')), [
      { machine: 'oldbox', session: 'sess-0', at: T0 },
    ]);
  });

  it('corrupt JSON backfills instead of 500ing reads', () => {
    assert.deepEqual(parseProvenance(row('{not-json')), [
      { machine: 'oldbox', session: 'sess-0', at: T0 },
    ]);
  });

  it('a valid list parses as-is', () => {
    const list = [
      { machine: 'a', session: 's', at: T0 },
      { machine: 'b', session: 't', at: T1 },
    ];
    assert.deepEqual(parseProvenance(row(JSON.stringify(list))), list);
  });

  it('a non-array JSON value backfills', () => {
    assert.deepEqual(parseProvenance(row('{"machine":"x"}')),
      [{ machine: 'oldbox', session: 'sess-0', at: T0 }],
    );
  });
});
