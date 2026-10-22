import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';

/**
 * A spawn-compatible fake built on execFile: runs the REAL command, then
 * replays the output through the SpawnedChild event surface gitRemoteOf
 * consumes (stdout data + close code). For the counting-spawner test.
 */
function execFileSpawner(cmd: string, args: string[]): { stdout: { on: (e: string, cb: (d: Buffer) => void) => void }; on: (e: string, cb: (...a: unknown[]) => void) => void; kill: () => void } {
  let dataCb: ((d: Buffer) => void) | null = null;
  let closeCb: ((...a: unknown[]) => void) | null = null;
  const child = {
    stdout: { on: (e: string, cb: (d: Buffer) => void) => { if (e === 'data') dataCb = cb; } },
    on: (e: string, cb: (...a: unknown[]) => void) => { if (e === 'close') closeCb = cb; },
    kill: () => undefined,
  };
  execFile(cmd, args, (err, stdout) => {
    setImmediate(() => {
      if (!err && stdout.length > 0 && dataCb) dataCb(Buffer.from(stdout));
      closeCb?.(err ? 1 : 0, null);
    });
  });
  return child;
}
import {
  clearGitRemoteCache,
  defaultRegistryPath,
  expandPath,
  gitRemoteOf,
  loadRegistry,
  parseRegistry,
  resolveProjectKey,
} from '../../src/hub-client/registry.js';

/** Create a throwaway git repo with a known `origin` remote (hermetic tests). */
function gitInit(dir: string, originUrl: string): void {
  execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', originUrl], { stdio: 'ignore' });
}

beforeEach(() => {
  clearGitRemoteCache();
});

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

  it('is code-fence aware: fenced examples do not register phantom sections', () => {
    const withExample = [
      '## real-project',
      '- remote: git@github.com:janesser/real.git',
      '',
      'Example format:',
      '```markdown',
      '## example-project',
      '- remote: git@github.com:example/fake.git',
      '```',
      '',
      '## another-real',
      '- remote: git@github.com:janesser/another.git',
    ].join('\n');
    const entries = parseRegistry(withExample);
    assert.deepEqual(
      entries.map((e) => e.name),
      ['real-project', 'another-real'],
    );
  });

  it('fence toggle handles ~~~ fences and unclosed fences', () => {
    const tilde = '## a\n- remote: git@github.com:x/a.git\n~~~\n## ghost\n- remote: git@github.com:x/ghost.git\n~~~\n## b\n- remote: git@github.com:x/b.git';
    assert.deepEqual(parseRegistry(tilde).map((e) => e.name), ['a', 'b']);
    const unclosed = '## a\n- remote: git@github.com:x/a.git\n```\n## ghost\n- remote: git@github.com:x/ghost.git';
    assert.deepEqual(parseRegistry(unclosed).map((e) => e.name), ['a']);
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

  it('resolves an explicit project name via its section', async () => {
    const r = await resolveProjectKey({ name: 'pi-hermes-memory' }, entries);
    assert.equal(r.key, 'https://github.com/chandra447/pi-hermes-memory');
    assert.equal(r.via, 'name');
  });

  it('name matching is case-insensitive', async () => {
    const r = await resolveProjectKey({ name: 'PI-Hermes-Memory' }, entries);
    assert.equal(r.key, 'https://github.com/chandra447/pi-hermes-memory');
  });

  it('normalizes the remote to the canonical project key (AD-10)', async () => {
    const r = await resolveProjectKey({ name: 'chezmoi' }, entries);
    assert.equal(r.key, 'https://github.com/janesser/xmonad.hs');
  });

  it('a section without a remote is a client error (null + note), never a guess', async () => {
    const r = await resolveProjectKey({ name: 'no-remote' }, entries);
    assert.equal(r.key, null);
    assert.match(r.note ?? '', /no remote/);
  });

  it('an unknown name is a client error (null + note) — and is NOT redirected to the cwd repo (review fix)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reg-name-'));
    try {
      gitInit(dir, 'https://github.com/other/repo.git');
      const r = await resolveProjectKey({ name: 'does-not-exist', cwd: dir }, entries);
      assert.equal(r.key, null);
      assert.match(r.note ?? '', /no entry for/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves by local path prefix (advisory locals)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-registry-cwd-'));
    try {
      const projectDir = path.join(dir, 'myproject');
      fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
      const hermetic = [
        '## myproject',
        `- remote: git@github.com:janesser/myproject.git`,
        `- local: ${projectDir}`,
      ].join('\n');
      const r = await resolveProjectKey({ cwd: path.join(projectDir, 'src') }, parseRegistry(hermetic));
      assert.equal(r.key, 'https://github.com/janesser/myproject');
      assert.equal(r.via, 'path');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('nameless resolution uses the cwd git remote (hermetic — review fix)', async () => {
    // A throwaway repo with a known origin — no dependence on this checkout:
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reg-git-'));
    try {
      gitInit(dir, 'git@github.com:janesser/some-fork.git');
      const r = await resolveProjectKey({ cwd: dir }, entries);
      assert.equal(r.via, 'git');
      assert.equal(r.key, 'https://github.com/janesser/some-fork');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gitRemoteOf returns null outside a git repo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-norepo-'));
    try {
      assert.equal(await gitRemoteOf(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gitRemoteOf is async and caches per cwd (a counting spawner proves one spawn — VG-21)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reg-cache-'));
    try {
      gitInit(dir, 'https://github.com/x/y.git');
      let spawns = 0;
      // The counting spawner runs the REAL git but counts invocations:
      const counting = (cmd: string, args: string[], _opts: unknown) => {
        spawns += 1;
        return execFileSpawner(cmd, args);
      };
      const a = await gitRemoteOf(dir, counting);
      const b = await gitRemoteOf(dir, counting);
      assert.equal(a, 'https://github.com/x/y.git');
      assert.equal(b, a);
      assert.equal(spawns, 1, 'the second call must be served from the cache');
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

describe('registry resolution edges (VG-19)', () => {
  it('a section with an EMPTY remote value is a "no remote" client error (note, not a guess)', async () => {
    const entries = parseRegistry('## broken\n- remote:');
    const r = await resolveProjectKey({ name: 'broken' }, entries);
    assert.equal(r.key, null);
    assert.match(r.note ?? '', /no remote/);
  });

  it('the normalizer never throws on non-empty input (permissive: garbage remote becomes a garbage key, no crash)', async () => {
    // Pins the permissiveness contract: normalizeProjectKey throws ONLY on
    // empty input. A malformed-but-present remote degrades to a key, never
    // to a crash or a silent local-path redirect.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reg-permissive-'));
    try {
      gitInit(dir, ':::not-a-url:::');
      const r = await resolveProjectKey({ cwd: dir }, []);
      assert.equal(r.via, 'git');
      assert.equal(r.key, 'https://:::not-a-url:::');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadRegistry: a missing file and an unreadable file both yield null (silent fallback)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reg-load-'));
    try {
      assert.equal(loadRegistry(path.join(dir, 'absent.md')), null);
      // A directory where a file should be: readFileSync throws → null:
      assert.equal(loadRegistry(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keep-look: a section without a remote is tried, then the NEXT matching path still resolves', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reg-keep-'));
    try {
      const a = path.join(dir, 'a');
      const b = path.join(dir, 'b');
      fs.mkdirSync(a);
      fs.mkdirSync(b);
      const entries = parseRegistry([
        '## no-remote-outer',
        `- local: ${dir}`,
        '## real-inner',
        '- remote: git@github.com:janesser/real-inner.git',
        `- local: ${b}`,
      ].join('\n'));
      // cwd inside `a` (matches the no-remote section's path, and also
      // `b`? no — a and b are siblings): resolves to nothing from `a`…
      const rA = await resolveProjectKey({ cwd: a }, entries);
      assert.equal(rA.key, null, 'a cwd under a no-remote section is not a resolution');
      // …and inside `b` it resolves via the parseable section:
      const rB = await resolveProjectKey({ cwd: b }, entries);
      assert.equal(rB.key, 'https://github.com/janesser/real-inner');
      assert.equal(rB.via, 'path');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
