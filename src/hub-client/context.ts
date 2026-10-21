/**
 * Shared-memory context — constructed once at extension startup, passed to
 * the memory tools. Null = shared memory not configured (or explicitly
 * disabled): every tool runs exactly v1.
 *
 * Enablement (story 2): the enrollment client file's PRESENCE turns shared
 * memory on. `sharedMemory: false` in the extension config is the off-switch
 * (e.g. a box that is enrolled but should run local-only for a while).
 */

import {
  createHubClient,
  defaultClientFilePath,
  type HubClient,
} from './client.js';
import {
  defaultRegistryPath,
  loadRegistry,
  resolveProjectKey,
  type RegistryEntry,
  type ResolveResult,
} from './registry.js';

export interface SharedMemoryOptions {
  /** Live hub connection (CA-pinned TLS, bearer token). */
  client: HubClient;
  /** Where the client reads the project registry (repo file by default). */
  registryPath: string;
}

export interface SharedMemoryConfigShape {
  /** Explicit off-switch. Default: on when the client file exists. */
  enabled?: boolean;
  /** Override the enrollment client file path (tests, non-standard boxes). */
  clientFile?: string;
  /** Override the registry path (tests, non-standard boxes). */
  registryPath?: string;
}

/**
 * Build the shared context, or null when shared memory is off/unconfigured.
 * Never throws: a broken client file degrades to "unconfigured" (the loader
 * already warns once on the console).
 */
export function createSharedMemoryOptions(
  config: SharedMemoryConfigShape | undefined,
): SharedMemoryOptions | null {
  if (config?.enabled === false) return null;
  const client: HubClient | null = createHubClient(config?.clientFile ?? defaultClientFilePath());
  if (client === null) return null;
  return {
    client,
    registryPath: config?.registryPath ?? defaultRegistryPath(),
  };
}

/**
 * Resolve a tool call's project reference against the registry (loaded fresh
 * — the file is small; `cz update` may have refreshed it since startup).
 */
export async function sharedResolve(
  opts: SharedMemoryOptions,
  name: string | null | undefined,
  cwd: string | null | undefined,
): Promise<ResolveResult> {
  const entries: RegistryEntry[] = loadRegistry(opts.registryPath) ?? [];
  return resolveProjectKey({ name, cwd }, entries);
}

/** Registry entries for the current registry path (fresh read). */
export function sharedRegistryEntries(opts: SharedMemoryOptions): RegistryEntry[] {
  return loadRegistry(opts.registryPath) ?? [];
}
