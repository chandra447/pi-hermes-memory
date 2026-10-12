/**
 * Mneme registry — classifies and holds pluggable providers.
 *
 * The Mneme layer (not the `MemoryProvider` base) that every provider is held
 * to: it records whether a provider is local (embedded, no external auth / no
 * running server — the v1 bar) and whether sync is bidirectional, and it
 * refuses non-local providers unless an operator has explicitly opted in.
 *
 * `MemoryProvider` (the host-driven base) is frozen and generic; the registry
 * is Mneme's own namespace and never changes the base.
 */

export type ProviderKind = "vector" | "document" | "hybrid";

/** A classified, registered provider (the registry's record, not the provider). */
export interface RegisteredProvider {
  /** Stable, provider-unique id (matches `MemoryProvider.name`). */
  id: string;
  /** Human label. */
  name: string;
  /** Retrieval strategy shape. */
  kind: ProviderKind;
  /** Embedded, no external auth/server — the v1 bar. */
  is_local: boolean;
  /** Whether sync pulls from the provider (true) or pushes only (false). */
  is_bidirectional: boolean;
  /** Provider-specific config (db_path, default_trust, hrr_dim, ...). */
  config?: Record<string, unknown>;
}

/**
 * Holds classified providers. Rejects a non-local provider unless the operator
 * has opted in (the v1 bar: embedded, no external auth, no running server).
 */
export class MnemeRegistry {
  private readonly providers = new Map<string, RegisteredProvider>();

  /**
   * @param allowNonLocal when true, non-local providers may be registered
   *   (an explicit operator opt-in); false is the v1 default.
   */
  constructor(private readonly allowNonLocal = false) {}

  register(provider: RegisteredProvider): void {
    if (!provider.id) throw new Error("Provider id is required");
    if (!provider.is_local && !this.allowNonLocal) {
      throw new Error(
        `Refusing to register non-local provider '${provider.id}': operator must opt in ` +
          "(v1 bar — embedded, no external auth, no running server).",
      );
    }
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider '${provider.id}' is already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): RegisteredProvider | undefined {
    return this.providers.get(id);
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  list(): RegisteredProvider[] {
    return [...this.providers.values()];
  }

  clear(): void {
    this.providers.clear();
  }
}
