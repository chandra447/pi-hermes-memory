#!/usr/bin/env node
/**
 * pi-memory-hub bin shim.
 *
 * The codebase uses `.js`-suffixed TypeScript imports, which Node's native
 * type-stripping does not remap — so this re-execs itself under the repo's
 * local `tsx` (the repo has no build step; see the hub-core spec design
 * notes). The env guard makes the re-exec idempotent.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const tsx = path.join(here, '..', 'node_modules', '.bin', 'tsx');
const cli = path.join(here, '..', 'src', 'hub', 'cli.ts');

if (process.env.PI_MEMORY_HUB_TSX_CHILD === '1') {
  await import(pathToFileURL(cli).href);
} else if (!existsSync(tsx)) {
  console.error('pi-memory-hub: tsx not found — run `npm ci` in the pi-hermes-memory checkout first.');
  process.exit(1);
} else {
  const child = spawn(process.execPath, [tsx, cli, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, PI_MEMORY_HUB_TSX_CHILD: '1' },
  });
  child.on('error', (err) => {
    console.error(`pi-memory-hub: failed to start tsx: ${err}`);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}
