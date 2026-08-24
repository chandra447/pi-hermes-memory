export interface LifecycleTimingOptions {
  enabled?: boolean;
  now?: () => number;
  log?: (line: string) => void;
}

function isEnabled(options: LifecycleTimingOptions): boolean {
  return options.enabled ?? process.env.PI_TIMING === "1";
}

function recordDuration(
  label: string,
  startedAt: number,
  options: LifecycleTimingOptions,
): void {
  try {
    const now = options.now ?? Date.now;
    const log = options.log ?? ((line: string) => console.error(line));
    const durationMs = Math.max(0, Math.round(now() - startedAt));
    log(`[pi-hermes-memory timing] ${label}: ${durationMs}ms`);
  } catch {
    // Profiling must not alter lifecycle behavior.
  }
}

export function measureLifecycleSync<T>(
  label: string,
  operation: () => T,
  options: LifecycleTimingOptions = {},
): T {
  if (!isEnabled(options)) return operation();
  const now = options.now ?? Date.now;
  const startedAt = now();
  try {
    return operation();
  } finally {
    recordDuration(label, startedAt, options);
  }
}

export async function measureLifecycle<T>(
  label: string,
  operation: () => Promise<T>,
  options: LifecycleTimingOptions = {},
): Promise<T> {
  if (!isEnabled(options)) return operation();
  const now = options.now ?? Date.now;
  const startedAt = now();
  try {
    return await operation();
  } finally {
    recordDuration(label, startedAt, options);
  }
}
