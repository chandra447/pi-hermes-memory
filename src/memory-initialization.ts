import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type EnsureMemoryReady = (ctx: Pick<ExtensionContext, "cwd">) => Promise<void>;

/** Share the first load across callers, but allow retry after a failed load. */
export function createMemoryInitializer(initialize: () => Promise<void>) {
  let pending: Promise<void> | undefined;
  let ready = false;
  let closed = false;

  return {
    isReady: () => ready,
    ensure(): Promise<void> {
      if (closed) return Promise.reject(new Error("Memory session has shut down"));
      if (ready) return Promise.resolve();
      pending ??= Promise.resolve().then(initialize).then(() => {
        ready = true;
      }).finally(() => {
        pending = undefined;
      });
      return pending.then(() => {
        if (closed) throw new Error("Memory session has shut down");
      });
    },
    async close(): Promise<void> {
      closed = true;
      // Join existing work without starting an unused memory subsystem.
      await pending?.catch(() => {});
    },
  };
}

/** Guard memory entry points without changing schemas, rendering or events. */
export function withMemoryInitialization(pi: ExtensionAPI, ensure: EnsureMemoryReady): ExtensionAPI {
  return {
    ...pi,
    registerTool(tool) {
      pi.registerTool({
        ...tool,
        async execute(id, params, signal, onUpdate, ctx) {
          signal?.throwIfAborted();
          await ensure(ctx);
          signal?.throwIfAborted();
          return tool.execute(id, params, signal, onUpdate, ctx);
        },
      });
    },
    registerCommand(name, options) {
      pi.registerCommand(name, {
        ...options,
        async handler(args, ctx) {
          await ensure(ctx);
          return options.handler(args, ctx);
        },
      });
    },
  };
}
