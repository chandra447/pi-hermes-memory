/**
 * Hub token store (spine AD-5) — the hub is the sole credential authority.
 *
 * One JSON file under the hub directory (local-only, never chezmoi — secrets
 * do not ride in the dotfiles repo). The store is re-read on every verify:
 * rotation (re-enroll) and revocation take effect without a hub restart.
 *
 * Tokens are random 256-bit values, printed once at enrollment (the CLI
 * prints the client file), and only their SHA-256 hash is persisted. The
 * token's identity IS the machine identity used for provenance (AD-8).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface TokenRecord {
  machine: string;
  token_sha256: string;
  enrolled_at: string;
}

interface TokenStoreFile {
  version: 1;
  machines: Record<string, TokenRecord>;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

const MACHINE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;

/**
 * Per-machine token store backed by one JSON file.
 */
export class TokenStore {
  constructor(private readonly filePath: string) {}

  private read(): TokenStoreFile {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, machines: {} };
      }
      throw err;
    }
    const parsed = JSON.parse(raw) as TokenStoreFile;
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.machines !== 'object' || parsed.machines === null) {
      throw new Error(`token store at ${this.filePath} is malformed`);
    }
    return parsed;
  }

  private write(file: TokenStoreFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }

  /**
   * Enroll a machine (or re-enroll = rotate). Returns the plaintext token —
   * it is shown exactly once, to the human running the enrollment.
   */
  enroll(machine: string): { machine: string; token: string; enrolled_at: string } {
    const name = machine.trim();
    if (!MACHINE_NAME_PATTERN.test(name) || name.length > 64) {
      throw new Error(`invalid machine name: ${JSON.stringify(machine)}`);
    }
    const key = name.toLowerCase();
    const token = `pmh_${randomBytes(32).toString('base64url')}`;
    const file = this.read();
    const enrolled_at = nowIso();
    file.machines[key] = { machine: key, token_sha256: sha256Hex(token), enrolled_at };
    this.write(file);
    return { machine: key, token, enrolled_at };
  }

  /**
   * Verify a bearer token → the machine identity, or null. Re-reads the file
   * per call (no restart on rotation/revocation, AD-5).
   */
  verify(token: string): string | null {
    if (typeof token !== 'string' || token.length === 0) return null;
    const digest = Buffer.from(sha256Hex(token), 'hex');
    const file = this.read();
    for (const record of Object.values(file.machines)) {
      const expected = Buffer.from(record.token_sha256, 'hex');
      if (expected.length === digest.length && timingSafeEqual(expected, digest)) {
        return record.machine;
      }
    }
    return null;
  }

  /** Revoke a machine's token. Returns true when an entry was removed. */
  revoke(machine: string): boolean {
    const key = machine.trim().toLowerCase();
    const file = this.read();
    if (!(key in file.machines)) return false;
    delete file.machines[key];
    this.write(file);
    return true;
  }

  listMachines(): Array<{ machine: string; enrolled_at: string }> {
    const file = this.read();
    return Object.values(file.machines)
      .map((r) => ({ machine: r.machine, enrolled_at: r.enrolled_at }))
      .sort((a, b) => a.machine.localeCompare(b.machine));
  }
}
