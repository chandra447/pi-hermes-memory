/**
 * Mneme host wiring — the single seam index.ts calls to bring Mneme to life.
 *
 * `setupMnemeHost` does the one-time cost (build the build, register the
 * provider tools, install the write-mirror) and then hands back the per-event
 * callbacks index.ts wires into Pi's own event loop:
 *
 *   - systemPromptBlock() : static provider section, appended to the system prompt
 *   - prefetchAll(query)   : dynamic recall text for the turn being built
 *   - onSessionStart(ctx)  : initialize each provider for the session
 *   - onSessionShutdown()  : release each provider (close its store)
 *
 * When Mneme is disabled the returned host is a no-op (empty strings,
 * no-ops) so the event handlers stay in place but do nothing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../../store/memory-store.js";
import type { MemoryConfig } from "../../types.js";
import { buildMneme } from "./manager.js";
import type { RegisteredProvider } from "./registry.js";
import { registerProviderTools } from "./provider-tools.js";
import type { MemoryProvider } from "../holographic/memory-provider.js";
import { isTrivialPrompt } from "../holographic/memory-provider.js";

/** The per-event hooks index.ts attaches to Pi's lifecycle. */
export interface MnemeHost {
  /** Static system-prompt section of all initialized providers ("" when none). */
  systemPromptBlock: () => string;
  /**
   * Dynamic recall text for a turn. Returns "" for trivial/gated prompts or when
   * no provider is initialized. Safe to call from before_agent_start.
   */
  prefetchAll: (query: string) => string;
  /** Initialize each provider for the session (get the session id from ctx). */
  onSessionStart: (ctx: ExtensionContext) => Promise<void>;
  /** Release each provider — close its store. Safe to call after shutdown. */
  onSessionShutdown: () => Promise<void>;
}

/** The session id, or "" when the host has none yet (best-effort, never throws). */
function resolveSessionId(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionId() ?? "";
  } catch {
    return "";
  }
}

function noopHost(): MnemeHost {
  return {
    systemPromptBlock: () => "",
    prefetchAll: () => "",
    onSessionStart: async () => {},
    onSessionShutdown: async () => {},
  };
}

function makeHost(providers: { provider: MemoryProvider; registered: RegisteredProvider }[]): MnemeHost {
  return {
    systemPromptBlock: () =>
      providers
        .map(({ provider }) => provider.systemPromptBlock())
        .filter((block): block is string => typeof block === "string" && block.length > 0)
        .join("\n\n"),

    prefetchAll: (query) => {
      if (!query || isTrivialPrompt(query)) return "";
      return providers
        .map(({ provider }) => {
          try {
            return provider.prefetch(query);
          } catch (error) {
            console.debug(`Mneme prefetch failed for '${provider.name}': ${error}`);
            return "";
          }
        })
        .filter((block): block is string => block.length > 0)
        .join("\n\n");
    },

    onSessionStart: async (ctx) => {
      const sessionId = resolveSessionId(ctx);
      for (const { provider, registered } of providers) {
        try {
          provider.initialize(sessionId, registered.config);
        } catch (error) {
          console.warn(`⚠️ Mneme provider '${provider.name}' initialization failed: ${error}`);
        }
      }
    },

    onSessionShutdown: async () => {
      for (const { provider } of providers) {
        try {
          provider.shutdown();
        } catch (error) {
          console.debug(`Mneme shutdown failed for '${provider.name}': ${error}`);
        }
      }
    },
  };
}

/**
 * Build the Mneme host for the given config. Registers provider tools and the
 * write-mirror once; returns a no-op host when Mneme is disabled.
 */
export function setupMnemeHost(
  pi: ExtensionAPI,
  config: MemoryConfig,
  store: MemoryStore,
): MnemeHost {
  const build = buildMneme(config);
  if (!build) return noopHost();
  const { providers } = build;

  // Register every tool each provider declares (one Pi tool per schema).
  for (const { provider } of providers) {
    registerProviderTools(pi, provider);
  }

  // Mirror built-in memory writes back into each provider's facts. The Hermes
  // store is the write source of truth; a fact that survives here becomes a
  // Holographic fact via addFact. Guarded so a provider error never breaks a
  // memory write.
  store.setWriteMirror((action, target, content) => {
    for (const { provider } of providers) {
      try {
        provider.onMemoryWrite(action, target, content);
      } catch (error) {
        console.debug(`Mneme write-mirror failed for '${provider.name}': ${error}`);
      }
    }
  });

  return makeHost(providers);
}
