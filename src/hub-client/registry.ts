/**
 * Project registry — the single reader (spine seam: registry format and this
 * parser change in the same change).
 *
 * The registry is markdown in the chezmoi repo (`discoveries/REGISTRY.md`),
 * one `## <name>` section per project with `- key: value` lines:
 * - `remote:` — the canonical identity (normalized to a project key)
 * - `local:`  — advisory checkout path(s); may be absent (status must be
 *   resolvable without a local checkout)
 * - `docs:`   — discovery document links (human-facing; the client ignores)
 *
 * Resolution order for a tool call:
 * 1. cwd's git remote (works even with no registry entry — the remote IS
 *    the identity, AD-10)
 * 2. explicit project name → section match → its remote
 * 3. cwd under an advisory `local:` path → that section's remote
 *
 * A missing registry entry is a CLIENT error (return null; the caller skips
 * the shared project op and says so) — never a hub concern (AD-10).
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve as resolvePath, sep } from 'node:path';
import { normalizeProjectKey } from '../shared/project-key.js';

export interface RegistryEntry {
  name: string;
  /** Canonical identity — the git remote, as written. */
  remote?: string;
  /** Advisory local checkout path(s), as written (may need `~` expansion). */
  locals: string[];
  /** Discovery doc links (human-facing; the client ignores them). */
  docs: string[];
}

const SECTION_RE = /^##\s+(.+?)\s*$/;
const FIELD_RE = /^-\s+([a-z_]+)\s*:\s*(.+?)\s*$/;
/**
 * Code-fence delimiters. The OPENING char is tracked: a block opened with
 * ``` only closes on ``` — a ~~~ line inside a ``` block is content, not a
 * fence toggle (mixed styles in a human-maintained file would otherwise
 * re-enter fence state mid-file and swallow/phantom sections, EC-13).
 */
const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})/;

/**
 * Parse registry markdown into entries. Tolerant: bad lines are skipped.
 * Code-fence aware: `##`/`- key:` lines inside a fenced block (a pasted
 * example) are NOT sections/fields — this file is human-maintained.
 */
export function parseRegistry(markdown: string): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  let current: RegistryEntry | null = null;
  let fenceChar: '`' | '~' | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const fence = line.match(FENCE_OPEN_RE);
    if (fence) {
      const ch = fence[1][0] as '`' | '~';
      if (fenceChar === null) fenceChar = ch;
      else if (ch === fenceChar) fenceChar = null;
      continue;
    }
    if (fenceChar !== null) continue;
    const section = line.match(SECTION_RE);
    if (section) {
      current = { name: section[1], locals: [], docs: [] };
      entries.push(current);
      continue;
    }
    if (current === null) continue; // preamble before the first section
    const field = line.match(FIELD_RE);
    if (!field) continue;
    const [, key, value] = field;
    if (key === 'remote') current.remote = value;
    else if (key === 'local') current.locals.push(value);
    else if (key === 'docs') current.docs.push(value);
    // unknown keys are ignored (format evolution must not break readers)
  }
  return entries;
}

/** Read + parse the registry file. Missing/unreadable → null (not an error). */
export function loadRegistry(filePath: string): RegistryEntry[] | null {
  try {
    if (!existsSync(filePath)) return null;
    return parseRegistry(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Expand a leading `~` to the home directory. */
export function expandPath(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return resolvePath(homedir(), p.slice(2));
  return resolvePath(p);
}

/**
 * The `origin` remote URL of the repo at `cwd` (null if not in a repo).
 * Async (a synchronous spawn would block the tool's event loop); bounded
 * by a 1 s timeout; results are cached per cwd (the cwd rarely changes
 * within a session, and `git` on a healthy repo answers in ~10 ms).
 * `spawnImpl` is injectable for tests (a counting spawner proves the cache
 * actually prevents the second spawn — VG-21).
 */
const gitRemoteCache = new Map<string, string | null>();

export interface SpawnedChild {
  stdout: { on(event: string, cb: (d: Buffer) => void): void };
  on(event: string, cb: (...args: unknown[]) => void): void;
  kill(): void;
}
export type SpawnImpl = (cmd: string, args: string[], opts: SpawnOptions) => SpawnedChild;

const defaultSpawn: SpawnImpl = (cmd, args, opts) => spawn(cmd, args, opts) as unknown as SpawnedChild;

export function gitRemoteOf(cwd: string, spawnImpl: SpawnImpl = defaultSpawn): Promise<string | null> {
  const hit = gitRemoteCache.get(cwd);
  if (hit !== undefined) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const child = spawnImpl('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, 1000);
    function finish(result: string | null): void {
      clearTimeout(timer);
      gitRemoteCache.set(cwd, result);
      resolve(result);
    }
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      const url = out.trim();
      finish(code === 0 && url.length > 0 ? url : null);
    });
  });
}

/** Test hook: clear the per-cwd git-remote cache. */
export function clearGitRemoteCache(): void {
  gitRemoteCache.clear();
}

export interface ResolveOptions {
  /** Explicit project name from the tool call (e.g. `memory_search(project=…)`). */
  name?: string | null;
  /** The agent's working directory. */
  cwd?: string | null;
}

export interface ResolveResult {
  /** Normalized project key, or null when unresolvable (AD-10 client error). */
  key: string | null;
  /** How the key was found (for diagnostics/notes). */
  via: 'git' | 'name' | 'path' | null;
  /** Set when a registry section was found but had no usable remote. */
  note?: string;
}

/**
 * Resolve a tool call's project reference to a normalized project key.
 * The git lookup is a bounded, cached async spawn.
 *
 * PRECEDENCE (review-fixed): an EXPLICIT name is authoritative — it
 * resolves via the registry, and a missing registry entry is an AD-10
 * client error (null + note), never silently redirected to the cwd's
 * repo. The cwd's git remote is consulted only for nameless calls (the
 * "the agent is working inside this repo" case), then advisory local
 * paths. (Git-first for named calls let `search(project="chezmoi")` from
 * inside repo Y search Y's key — the wrong project.)
 */
export async function resolveProjectKey(opts: ResolveOptions, entries: RegistryEntry[]): Promise<ResolveResult> {
  const { name, cwd } = opts;

  // 1. Explicit name → registry section match (case-insensitive).
  if (name) {
    const entry = entries.find((e) => e.name.toLowerCase() === name.trim().toLowerCase());
    if (entry) {
      if (entry.remote) {
        try {
          return { key: normalizeProjectKey(entry.remote), via: 'name' };
        } catch {
          return { key: null, via: null, note: `registry entry "${entry.name}" has an unparseable remote` };
        }
      }
      return { key: null, via: null, note: `registry entry "${entry.name}" has no remote` };
    }
    // Name not in the registry: AD-10 client error — do NOT fall back to
    // the cwd's git remote (that would search a different project).
    return { key: null, via: null, note: `registry has no entry for "${name}"` };
  }

  // 2. Nameless: the cwd's git remote — the identity lives in git.
  if (cwd) {
    const remote = await gitRemoteOf(cwd);
    if (remote) {
      try {
        return { key: normalizeProjectKey(remote), via: 'git' };
      } catch {
        // unparseable remote — fall through to the local paths.
      }
    }
  }

  // 3. cwd under an advisory local path.
  if (cwd) {
    const realCwd = safeRealpath(cwd);
    for (const entry of entries) {
      for (const local of entry.locals) {
        const realLocal = safeRealpath(expandPath(local));
        if (realLocal === null || realCwd === null) continue;
        if (realCwd === realLocal || realCwd.startsWith(realLocal + sep)) {
          if (entry.remote) {
            try {
              return { key: normalizeProjectKey(entry.remote), via: 'path' };
            } catch {
              // unparseable — keep looking.
            }
          }
          break;
        }
      }
    }
  }

  return { key: null, via: null };
}

function safeRealpath(p: string): string | null {
  try {
    if (!statSync(p).isDirectory()) return null;
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * The default registry location: the chezmoi repo file (decision Q2=d). The
 * repo itself is the managed artifact — `cz update` keeps it current on every
 * box — so the client reads it directly; no extra chezmoi surface.
 */
export function defaultRegistryPath(): string {
  return resolvePath(homedir(), '.local/share/chezmoi/discoveries/REGISTRY.md');
}

/** Stable parent dir, handy for tests asserting the convention. */
export function defaultRegistryDir(): string {
  return dirname(defaultRegistryPath());
}
