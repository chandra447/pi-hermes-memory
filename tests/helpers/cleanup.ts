import fs from "node:fs";
import { AtomicLockCoordinator } from "../../src/store/atomic-lock-coordinator.js";

/**
 * Release shared lock-coordinator handles before deleting a store directory.
 *
 * On Windows an open SQLite file cannot be unlinked, so a teardown that only
 * calls `fs.rm` fails with `EBUSY: resource busy or locked` on
 * `.pi-hermes-locks.sqlite`. The shared coordinator pins that connection for
 * its lifetime, so the handle has to be dropped explicitly.
 */
export function releaseMemoryLockHandles(): void {
  AtomicLockCoordinator.closeHandles();
}

/** Synchronous directory teardown that survives Windows file locking. */
export function rmTestDirSync(dir: string): void {
  releaseMemoryLockHandles();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
}

/** Async directory teardown that survives Windows file locking. */
export async function rmTestDir(dir: string): Promise<void> {
  releaseMemoryLockHandles();
  await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
}
