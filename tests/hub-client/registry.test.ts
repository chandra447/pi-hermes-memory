import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  defaultRegistryPath,
  expandPath,
  gitRemoteOf,
  loadRegistry,
  parseRegistry,
  resolveProjectKey,
} from '../../src/hub-client/registry.js';

const SAMPLE = `
# Project registry

Preamble text that is not a section.

## chezmoi
- remote: git@github.com:janesser/xmonad.hs.git
- local: ~/.local/share/chezmoi
- docs: chezmoi-evolution-sources.md

## pi-hermes-memory
- remote: https://github.com/chandra447/pi-hermes-memory.git
- local: ~/projs/pi-hermes-memory
- local: /home/jan/projs/alt-checkout
- docs: ai-graph-knowledge.md

## no-remote
- local: ~/somewhere

## future-project
- remote: git@github.com:janesser/future.git
- unknown_key: readers must ignore this
`;

describe('registry parser (story 2 — single reader, seam with the format)', () => {
  it('parses sections and fields; ignores preamble and unknown keys', () => {
    const entries = parseRegistry(SAMPLE);
    assert.equal(entries.length, 4);
    assert.deepEqual(
      entries.map((e) => e.name),
      ['chezmoi', 'pi-hermes-memory', 'no-remote', 'future-project'],
    );
    const chezmoi = entries[0];
    assert.equal(chezmoi.remote, 'git@github.com:janesser/xmonad.hs.git');
    assert.deepEqual(chezmoi.locals, ['~/.local/share/chezmoi']);
    assert.deepEqual(chezmoi.docs, ['chezmoi-evolution-sources.md']);
    assert.deepEqual(entries[1].locals, ['~/projs/pi-hermes-memory', '/home/jan/projs/alt-checkout']);
    assert.equal(entries[2].remote, undefined);
  });

  it('loadRegistry: missing file → null (not an error)', () => {
    assert.equal(loadRegistry('/nonexistent/REGISTRY.md'), null);
  });

  it('loadRegistry reads a real file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-registry-'));
    try {
      const file = path.join(dir, 'REGISTRY.md');
      fs.writeFileSync(file, SAMPLE);
      assert.equal(loadRegistry(file)!.length, 4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('registry resolution (AD-10: client-side, key before the hub call)', () => {
  const entries = parseRegistry(SAMPLE);

  it('resolves an explicit project name via its section', () => {
    const r = resolveProjectKey({ name: 'pi-hermes-memory' }, entries);
    assert.equal(r.key, 'https://github.com/chandra447/pi-hermes-memory');
    assert.equal(r.via, 'name');
  });

  it('name matching is case-insensitive', () => {
    const r = resolveProjectKey({ name: 'PI-Hermes-Memory' }, entries);
    assert.equal(r.key, 'https://github.com/chandra447/pi-hermes-memory');
  });

  it('normalizes the remote to the canonical project key (AD-10)', () => {
    const r = resolveProjectKey({ name: 'chezmoi' }, entries);
    assert.equal(r.key, 'https://github.com/janesser/xmonad.hs');
  });

  it('a section without a remote is a client error (null + note), never a guess', () => {
    const r = resolveProjectKey({ name: 'no-remote' }, entries);
    assert.equal(r.key, null);
    assert.match(r.note ?? '', /no remote/);
  });

  it('an unknown name is a client error (null, no note)', () => {
    const r = resolveProjectKey({ name: 'does-not-exist' }, entries);
    assert.equal(r.key, null);
    assert.equal(r.via, null);
  });

  it('resolves by local path prefix (advisory locals)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-registry-cwd-'));
    try {
      const projectDir = path.join(dir, 'myproject');
      fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
      const hermetic = [
        '## myproject',
        `- remote: git@github.com:janesser/myproject.git`,
        `- local: ${projectDir}`,
      ].join('\n');
      const r = resolveProjectKey({ cwd: path.join(projectDir, 'src') }, parseRegistry(hermetic));
      assert.equal(r.key, 'https://github.com/janesser/myproject');
      assert.equal(r.via, 'path');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the git remote of the cwd wins over the registry (the identity lives in git)', () => {
    // In THIS repo (the test runs from the checkout), cwd = the repo root:
    const r = resolveProjectKey({ cwd: process.cwd() }, entries);
    assert.equal(r.via, 'git');
    assert.match(r.key ?? '', /^https:\/\/github\.com\//);
  });

  it('gitRemoteOf returns null outside a git repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-norepo-'));
    try {
      assert.equal(gitRemoteOf(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('expandPath handles ~ and absolute paths', () => {
    assert.equal(expandPath('~/x'), path.join(os.homedir(), 'x'));
    assert.equal(expandPath('~'), os.homedir());
    assert.equal(expandPath('/abs/path'), '/abs/path');
  });

  it('the default registry path is the chezmoi repo file (decision Q2=d)', () => {
    assert.equal(
      defaultRegistryPath(),
      path.join(os.homedir(), '.local/share/chezmoi/discoveries/REGISTRY.md'),
    );
  });
});
