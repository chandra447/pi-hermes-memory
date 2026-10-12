/**
 * Mneme manager — turns `config.mneme` into a ready registry + instantiated
 * providers. Pure and testable; `index.ts` calls it to do the live wiring
 * (store write-mirror, tool registration).
 *
 * v1 policy: Mneme is disabled until `mneme.enabled` is set; only local
 * (embedded, no external auth/server) providers load unless the operator opts
 * in. The only v1 provider is Holographic.
 */

import type { MemoryConfig } from "../../types.js";
import { HolographicMemoryProvider } from "../holographic/holographic.js";
import type { MemoryProvider } from "../holographic/memory-provider.js";
import { MnemeRegistry, type RegisteredProvider } from "./registry.js";

/** A manager-owned provider plus its registry record. */
export interface MnemeManagedProvider {
  provider: HolographicMemoryProvider;
  registered: RegisteredProvider;
}

/** Result of `buildMneme`: the registry plus instantiated, selected providers. */
export interface MnemeBuild {
  registry: MnemeRegistry;
  providers: MnemeManagedProvider[];
}

/**
 * Build the Mneme registry + providers from config. Returns `null` when Mneme
 * is not enabled (the default), so the rest of the extension is unaffected.
 *
 * Throws if a selected provider id is unknown or a non-local provider is
 * opted in without the operator allowing it.
 */
export function buildMneme(config: MemoryConfig): MnemeBuild | null {
  const mneme = config.mneme;
  if (!mneme?.enabled) return null;

  // v1 bar: embedded, no external auth, no running server. Non-local requires
  // an explicit opt-in that we do not yet surface; keep the flag for later.
  const allowNonLocal = (mneme as { allow_non_local?: boolean }).allow_non_local === true;
  const registry = new MnemeRegistry(allowNonLocal);

  // Undefined = "all registered"; v1 has just Holographic, so default to it.
  const selected = mneme.providers && mneme.providers.length > 0
    ? mneme.providers
    : ["holographic"];

  const providers: MnemeManagedProvider[] = [];
  for (const id of selected) {
    switch (id) {
      case "holographic": {
        const provider = new HolographicMemoryProvider({
          // Only the plugin keys Holographic reads; enabled/providers are ignored by the ctor.
          db_path: mneme.db_path,
          auto_extract: mneme.auto_extract,
          default_trust: mneme.default_trust,
          min_trust_threshold: mneme.min_trust_threshold,
          temporal_decay_half_life: mneme.temporal_decay_half_life,
          hrr_dim: mneme.hrr_dim,
          hrr_weight: mneme.hrr_weight,
        });
        const registered: RegisteredProvider = {
          id: provider.name,
          name: "Holographic",
          kind: "hybrid",
          is_local: true,
          is_bidirectional: false,
          config: {
            db_path: mneme.db_path,
            default_trust: mneme.default_trust,
            min_trust_threshold: mneme.min_trust_threshold,
            temporal_decay_half_life: mneme.temporal_decay_half_life,
            hrr_dim: mneme.hrr_dim,
            hrr_weight: mneme.hrr_weight,
          },
        };
        registry.register(registered);
        providers.push({ provider, registered });
        break;
      }
      default:
        throw new Error(`Unknown Mneme provider '${id}'. Known providers: holographic.`);
    }
  }

  return { registry, providers };
}
