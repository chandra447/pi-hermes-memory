import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type MemoryContext = Pick<ExtensionContext, "cwd">;
export type EnsureMemoryReady = (ctx: MemoryContext, signal?: AbortSignal) => Promise<void>;

/** Cancel one waiter without cancelling initialization shared with other users. */
function waitForReady(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Memory operation aborted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Own initialization, per-use preparation and operations through shutdown. */
export function createMemoryInitializer(
  initialize: () => Promise<void>,
  prepare?: (ctx: MemoryContext) => Promise<void>,
) {
  let pending: Promise<void> | undefined;
  let initialized = false;
  let ready = false;
  let closed = false;
  const active = new Set<Promise<unknown>>();

  function assertOpen(): void {
    if (closed) throw new Error("Memory session has shut down");
  }

  function track<T>(work: Promise<T>): Promise<T> {
    active.add(work);
    void work.then(() => active.delete(work), () => active.delete(work));
    return work;
  }

  async function ensure(ctx?: MemoryContext, signal?: AbortSignal): Promise<void> {
    assertOpen();
    signal?.throwIfAborted();
    if (!initialized) {
      pending ??= Promise.resolve().then(initialize).then(() => {
        initialized = true;
      }).finally(() => {
        pending = undefined;
      });
    }
    // Track the underlying preparation even when an individual waiter cancels.
    const preparation = track((pending ?? Promise.resolve()).then(async () => {
      if (ctx) await prepare?.(ctx);
      ready = true;
    }));
    await waitForReady(preparation, signal);
    signal?.throwIfAborted();
    assertOpen();
  }

  return {
    isReady: () => ready,
    ensure,
    run<T>(ctx: MemoryContext, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      return track(ensure(ctx, signal).then(() => {
        assertOpen();
        signal?.throwIfAborted();
        return work();
      }));
    },
    async close(): Promise<void> {
      closed = true;
      // No new work is accepted. Join loads, project binds, backfill and callers
      // already executing before the owner checkpoints/closes its database.
      await Promise.allSettled([...active]);
    },
  };
}

/** Guard memory entry points without changing schemas, rendering or events. */
export function withMemoryInitialization(
  pi: ExtensionAPI,
  initialization: Pick<ReturnType<typeof createMemoryInitializer>, "run">,
): ExtensionAPI {
  return {
    ...pi,
    registerTool(tool) {
      pi.registerTool({
        ...tool,
        async execute(id, params, signal, onUpdate, ctx) {
          return initialization.run(ctx, () => tool.execute(id, params, signal, onUpdate, ctx), signal);
        },
      });
    },
    registerCommand(name, options) {
      pi.registerCommand(name, {
        ...options,
        async handler(args, ctx) {
          return initialization.run(ctx, () => options.handler(args, ctx));
        },
      });
    },
  };
}
