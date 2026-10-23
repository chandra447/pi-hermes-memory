/**
 * fetchSharedProfile (story 4 — the session-start profile fetch).
 *
 * The best-effort contract: the fetch NEVER throws — unreachable, HTTP
 * errors, and malformed NDJSON all settle to `{ kind: 'down' }`, because a
 * profile fetch must never take down session start (the prompt then renders
 * the explicit degraded line — FR-16).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSharedProfile } from '../../src/hub-client/shared-profile.js';
import { HubHttpError, HubUnreachableError } from '../../src/hub-client/client.js';
import type { HubClient } from '../../src/hub-client/client.js';
import type { SharedEntry } from '../../src/shared/wire.js';

function stubClient(behavior: { probe?: boolean; rows?: SharedEntry[]; onExport?: () => unknown | never }): HubClient {
  const client = {
    probe: async () => behavior.probe ?? true,
    export: async () => {
      if (behavior.onExport) return behavior.onExport();
      return behavior.rows ?? [];
    },
  };
  return client as unknown as HubClient;
}

const entry = (over: Partial<SharedEntry> & { content: string }): SharedEntry =>
  ({
    id: '01900000-0000-7000-8000-000000000001',
    scope: 'memory',
    content: over.content,
    machine: 'box-a',
    session: 's',
    identity: 'box-a',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    provenance: [{ machine: 'box-a', session: 's', at: '2026-01-01T00:00:00.000Z' }],
    ...over,
  }) as SharedEntry;

describe('fetchSharedProfile (story 4)', () => {
  it('keeps ONLY the global user scope — project-attributed and other scopes are excluded', async () => {
    const client = stubClient({
      rows: [
        entry({ content: 'works in the evening', scope: 'user' }),
        entry({ content: 'a fact about project x', scope: 'memory', project_key: 'https://github.com/jan/x' }),
        entry({ content: 'project-attributed user note', scope: 'user', project_key: 'https://github.com/jan/x' }),
        entry({ content: 'a status entry', scope: 'memory', project_key: 'https://github.com/jan/x', kind: 'status', state: 'active' }),
        entry({ content: 'another user fact', scope: 'user' }),
      ],
    });
    const state = await fetchSharedProfile(client);
    assert.equal(state.kind, 'up');
    assert.deepEqual(state.entries, ['works in the evening', 'another user fact']);
  });

  it('an empty store resolves up with no entries (not down)', async () => {
    const state = await fetchSharedProfile(stubClient({ rows: [] }));
    assert.deepEqual(state, { kind: 'up', entries: [] });
  });

  it('probe down ⇒ down without calling export', async () => {
    let exportCalled = false;
    const client = stubClient({ probe: false, onExport: () => { exportCalled = true; return []; } });
    const state = await fetchSharedProfile(client);
    assert.deepEqual(state, { kind: 'down', entries: [] });
    assert.equal(exportCalled, false, 'a down probe must not pay for the export');
  });

  it('export failing UNREACHABLE (hub died after the probe) ⇒ down, never a throw', async () => {
    const client = stubClient({ onExport: () => { throw new HubUnreachableError('socket hang up'); } });
    const state = await fetchSharedProfile(client);
    assert.deepEqual(state, { kind: 'down', entries: [] });
  });

  it('export failing with an HTTP error (e.g. 500 mid-dump) ⇒ down, never a throw', async () => {
    const client = stubClient({ onExport: () => { throw new HubHttpError(500, 'internal_error', 'boom'); } });
    const state = await fetchSharedProfile(client);
    assert.deepEqual(state, { kind: 'down', entries: [] });
  });

  it('a MALFORMED export (plain parse error) ⇒ down, never a throw — session start must survive it', async () => {
    const client = stubClient({ onExport: () => { throw new Error('unexpected token'); } });
    const state = await fetchSharedProfile(client);
    assert.deepEqual(state, { kind: 'down', entries: [] });
  });
});
