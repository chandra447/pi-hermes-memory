import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  degradedBanner,
  degradedTag,
  mapLocalHit,
  mapSharedHit,
  mergeHits,
  unresolvedProjectNote,
  upStateLine,
  type UnifiedHit,
} from '../../src/hub-client/merge.js';
import type { SqliteMemoryEntry } from '../../src/store/sqlite-memory-store.js';

function localEntry(content: string, project: string | null = null): SqliteMemoryEntry {
  return {
    id: 1,
    project,
    target: 'memory',
    category: null,
    content,
    failureReason: null,
    toolState: null,
    correctedTo: null,
    created: '2026-01-01',
    lastReferenced: '2026-01-02',
  };
}

function sharedHit(content: string, machine: string, project?: string): UnifiedHit {
  return {
    id: '01900000-0000-7000-8000-000000000001',
    ...(project ? { project } : {}),
    target: 'memory',
    content,
    created: '2026-01-01T00:00:00.000Z',
    lastReferenced: '2026-01-02T00:00:00.000Z',
    machine,
    session: 'session-abc',
    provenance: [{ machine, session: 'session-abc', at: '2026-01-01T00:00:00.000Z' }],
    source: 'shared',
  };
}

const noKey = (_name: string): string | null => null;

describe('unified merge (AD-15 — one shape, one renderer)', () => {
  it('rank-interleaves local and shared hits', () => {
    const local = [mapLocalHit(localEntry('local one'), 'box-a'), mapLocalHit(localEntry('local two'), 'box-a')];
    const shared = [sharedHit('shared one', 'box-b'), sharedHit('shared two', 'box-b')];
    const merged = mergeHits(local, shared, 10, noKey);
    assert.deepEqual(
      merged.map((h) => h.content),
      ['local one', 'shared one', 'local two', 'shared two'],
    );
  });

  it('caps at limit after interleaving', () => {
    const local = [mapLocalHit(localEntry('l1'), 'x'), mapLocalHit(localEntry('l2'), 'x'), mapLocalHit(localEntry('l3'), 'x')];
    const shared = [sharedHit('s1', 'y'), sharedHit('s2', 'y')];
    const merged = mergeHits(local, shared, 3, noKey);
    assert.equal(merged.length, 3);
    assert.deepEqual(merged.map((h) => h.content), ['l1', 's1', 'l2']);
  });

  it('dedups on content hash — the SHARED hit wins (local residue never shadows)', () => {
    const local = [mapLocalHit(localEntry('same fact'), 'x')];
    const shared = [sharedHit('same fact', 'y')];
    const merged = mergeHits(local, shared, 10, noKey);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].source, 'shared');
  });

  it('dedup is insensitive to surrounding whitespace (the hash trims)', () => {
    const local = [mapLocalHit(localEntry('  same fact  '), 'x')];
    const shared = [sharedHit('same fact', 'y')];
    assert.equal(mergeHits(local, shared, 10, noKey).length, 1);
  });

  it('local project NAMES map to keys for dedup (registry resolution)', () => {
    const local = [mapLocalHit(localEntry('fact', 'proj-name'), 'x')];
    const shared = [sharedHit('fact', 'y', 'https://github.com/jan/proj')];
    const nameToKey = (name: string): string | null => (name === 'proj-name' ? 'https://github.com/jan/proj' : null);
    assert.equal(mergeHits(local, shared, 10, nameToKey).length, 1);
    // Without the mapping the identity differs and both survive:
    assert.equal(mergeHits(local, shared, 10, noKey).length, 2);
  });

  it('different scopes are different identities (no cross-scope dedup)', () => {
    const local = [mapLocalHit({ ...localEntry('fact'), target: 'user' }, 'x')];
    const shared = [{ ...sharedHit('fact', 'y'), target: 'memory' }];
    assert.equal(mergeHits(local, shared, 10, noKey).length, 2);
  });
});

describe('state lines (FR-16/FR-18 — explicit, never silent)', () => {
  it('up line states the shared count', () => {
    assert.equal(upStateLine(1), 'shared: up (1 shared hit)');
    assert.equal(upStateLine(3), 'shared: up (3 shared hits)');
  });

  it('the degraded banner is explicit about the consequence and the human loop', () => {
    const b = degradedBanner();
    assert.match(b, /shared memory unavailable/);
    assert.match(b, /local-only/);
    assert.match(b, /ask the human/);
  });

  it('the degraded tag is the compact form', () => {
    assert.equal(degradedTag(), 'shared: degraded (local only)');
  });

  it('the unresolved-project note names the project (AD-10 client error)', () => {
    assert.match(unresolvedProjectNote('mystery'), /"mystery"/);
    assert.match(unresolvedProjectNote('mystery', 'no remote'), /no remote/);
  });
});

describe('merge edges (VG-17, VG-20)', () => {
  it('category is part of the dedup identity: same content, different category ⇒ both render', () => {
    const local = [mapLocalHit({ ...localEntry('the fact'), category: 'insight' as never }, 'box-a')];
    const shared: UnifiedHit[] = [{ ...sharedHit('the fact', 'box-b'), category: 'correction' as never }];
    assert.equal(mergeHits(local, shared, 10, noKey).length, 2, 'different categories are different entries');
    // Same category on both sides → deduped:
    const sharedSame: UnifiedHit[] = [{ ...sharedHit('the fact', 'box-b'), category: 'insight' as never }];
    assert.equal(mergeHits(local, sharedSame, 10, noKey).length, 1);
  });

  it('unresolvable local project name in a GLOBAL search: both copies may render (BH-15)', () => {
    // The local hit's project name cannot be resolved to a key; the shared
    // hit is keyed. The identities differ → both render (they are genuinely
    // different project scoping — the shared project search was not run).
    const local = [mapLocalHit(localEntry('scoped fact', 'mystery-name'), 'box-a')];
    const shared = [sharedHit('scoped fact', 'box-b', 'https://github.com/x/y')];
    assert.equal(mergeHits(local, shared, 10, noKey).length, 2);
    // …while a RESOLVABLE local name dedups against the shared key:
    const nameToKey = (name: string): string | null => (name === 'mystery-name' ? 'https://github.com/x/y' : null);
    assert.equal(mergeHits(local, shared, 10, nameToKey).length, 1);
  });

  it('local hits carry the box name in the unified shape (VG-20)', () => {
    const hit = mapLocalHit(localEntry('machine check'), 'cyberkleiber');
    assert.equal(hit.machine, 'cyberkleiber', 'the local machine is this box\'s enrolled name');
    assert.equal(hit.source, 'local');
  });

  it('zero shared hits still produce the up state line (count 0 is a state, not an error)', () => {
    assert.equal(upStateLine(0), 'shared: up (0 shared hits)');
  });
});

describe('status-kind pass-through (story 3 — tagged by fields, never by content)', () => {
  it('mapSharedHit carries kind/state from the wire hit', () => {
    const hit = mapSharedHit({
      id: '01900000-0000-7000-8000-000000000002',
      project: 'https://github.com/jan/proj',
      target: 'memory',
      content: 'status: hardening — needs a rerun',
      created: '2026-01-01T00:00:00.000Z',
      lastReferenced: '2026-01-02T00:00:00.000Z',
      kind: 'status',
      state: 'hardening',
      machine: 'box-b',
      session: 'session-abc',
      identity: 'box-b',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      provenance: [{ machine: 'box-b', session: 'session-abc', at: '2026-01-01T00:00:00.000Z' }],
      source: 'shared',
    });
    assert.equal(hit.kind, 'status');
    assert.equal(hit.state, 'hardening');
  });

  it('mapSharedHit leaves kind/state absent for ordinary hits; mapLocalHit never has them', () => {
    const plain = mapSharedHit({
      id: '01900000-0000-7000-8000-000000000003',
      target: 'memory',
      content: 'a fact that merely says "status: active" in its text',
      created: '2026-01-01T00:00:00.000Z',
      lastReferenced: '2026-01-01T00:00:00.000Z',
      machine: 'box-b',
      session: 's',
      identity: 'box-b',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      provenance: [{ machine: 'box-b', session: 's', at: '2026-01-01T00:00:00.000Z' }],
      source: 'shared',
    });
    assert.equal(plain.kind, undefined, 'content mentioning a status word is NOT a status entry');
    assert.equal(plain.state, undefined);
    const local = mapLocalHit(localEntry('status: active'), 'box-a');
    assert.equal(local.kind, undefined);
    assert.equal(local.state, undefined);
  });
});
