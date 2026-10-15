/**
 * Project-key normalization — defined ONCE (spine convention "Project key
 * normalization"). Every client normalizes a project reference before calling
 * the hub; the hub stores the key as-is and never re-normalizes (AD-10).
 *
 * Canonical form: `https://<lowercase-host>/<lowercase-path>` —
 * - ssh SCP form `git@host:owner/repo` → `https://host/owner/repo`
 * - ssh URL `ssh://git@host[:port]/owner/repo` → `https://host/owner/repo`
 * - `http://` → `https://`
 * - trailing `.git` and slashes stripped, host + path lowercased
 *
 * The key is a machine-independent identity rooted in the git remote, never
 * a local path.
 */

const TRAILING_DOT_GIT = /\.git$/;

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Normalize a project reference (remote URL, SCP form, or bare `host/path`)
 * into the canonical project key. Throws on empty input — a missing registry
 * entry is a client error, not a normalization failure (AD-10).
 */
export function normalizeProjectKey(input: string): string {
  const raw = input.trim();
  if (raw.length === 0) {
    throw new Error('normalizeProjectKey: empty project reference');
  }

  let s = raw.toLowerCase();

  // SCP form: git@host:owner/repo (no scheme).
  const scp = s.match(/^([a-z0-9._-]+)@([a-z0-9._-]+):(.+)$/);
  if (scp && !s.includes('://')) {
    s = `https://${scp[2]}/${scp[3]}`;
  } else {
    // Scheme form: strip user@ from the authority.
    s = s.replace(/^ssh:\/\/[^/]*@/, 'ssh://').replace(/^(https?):\/\/[^/]*@/, '$1://');
    if (s.startsWith('ssh://')) {
      const m = s.match(/^ssh:\/\/([^:/]+)(?::(\d+))?\/(.+)$/);
      if (m) {
        s = m[2] && m[2] !== '22' ? `https://${m[1]}:${m[2]}/${m[3]}` : `https://${m[1]}/${m[3]}`;
      }
    } else if (!s.startsWith('http://') && !s.startsWith('https://')) {
      // Bare host/path, e.g. `github.com/jan/repo`.
      s = `https://${s}`;
    }
  }

  // Canonical scheme.
  if (s.startsWith('http://')) {
    s = `https://${s.slice('http://'.length)}`;
  }

  // Strip trailing slashes first, then a trailing .git (a `.git/` suffix
  // would hide the .git behind the slash otherwise).
  let rest = stripTrailingSlashes(s);
  if (TRAILING_DOT_GIT.test(rest)) {
    rest = rest.replace(TRAILING_DOT_GIT, '');
  }

  return rest;
}
