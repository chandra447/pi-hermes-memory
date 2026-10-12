/**
 * Mneme "clean hit" — the first-class operation.
 *
 * A clean hit is a provider result that has passed three gates before it is
 * ever returned to the agent:
 *
 *   1. Scope      — the hit matches the requested category (drops cross-category leakage).
 *   2. Recency    — the hit is not past its effective-decay cutoff.
 *   3. Source of  — the hit survives the same `scanContent` write gate the local
 *    truth             store uses (no injection/exfiltration/secret patterns).
 *
 * `cleanHit` adapts a provider's *raw recall* — it does not call the tool
 * dispatch path. The provider exposes a small additive `recall(query, options)`
 * that returns shaped hits; this layer applies the gates. Providers inject this
 * layer; they don't subclass the extension.
 */

import { scanContent } from "../../store/content-scanner.js";
import type { MemoryCategory } from "../../types.js";

export interface ProviderSearchOptions {
  /** Max results to consider. */
  limit?: number;
  /**
   * Scope filter — one of the six canonical Mneme memory scopes
   * (`failure | correction | insight | preference | convention | tool-quirk`).
   * Mneme standardizes on this vocabulary everywhere; there is no per-provider
   * category namespace and no mapping layer. `undefined` = no scope filter.
   */
  category?: MemoryCategory;
  /**
   * ISO timestamp; hits whose content is older than this are dropped.
   * `undefined` = no recency filter.
   */
  minRecencyAt?: string;
}

/** A single shaped hit, as `cleanHit` sees it. */
export interface ProviderSearchHit {
  /** Provider-stable id (e.g. fact_id). */
  id: string;
  content: string;
  /** Trust score, if the provider reports one. */
  trust?: number;
  /**
   * Created timestamp — mandatory. Memory age drives relevance: a fact's age is
   * a first-order signal of whether it is still useful or needs re-validation.
   */
  created_at: string;
  /**
   * Last-updated timestamp — mandatory. When the content was last re-validated;
   * feeds the recency gate's re-validation check.
   */
  updated_at: string;
  /** Category — one of the six canonical Mneme memory scopes. */
  category?: MemoryCategory;
  /** The full underlying provider row, for callers that want it. */
  raw_match: Record<string, unknown>;
}

export interface ProviderSearchResult {
  hits: ProviderSearchHit[];
  /** How many rows were considered before gating. */
  raw_matches: number;
}

/** Any provider that exposes a shaped `recall`. Kept narrow so the layer is provider-agnostic. */
export interface RecallableProvider {
  recall(query: string, options?: ProviderSearchOptions): ProviderSearchHit[];
}

/**
 * Run a query through a provider's raw recall, then apply the three clean-hit
 * gates. Returns the clean hits plus the raw count considered.
 */
export function cleanHit(
  provider: RecallableProvider,
  query: string,
  options: ProviderSearchOptions,
): ProviderSearchResult {
  const raw = provider.recall(query, options);
  const minRecencyTs = options.minRecencyAt ? Date.parse(options.minRecencyAt) : undefined;
  const hits = raw.filter((h) => {
    // Gate 1: scope.
    if (options.category !== undefined && h.category !== options.category) return false;
    // Gate 2: recency. Age (created_at) drives relevance; last-edit (updated_at)
    // drives re-validation — use the OLDER of the two (strictest). Missing either
    // fails closed: without both timestamps the gate can't prove freshness.
    if (minRecencyTs !== undefined) {
      const createdTs = h.created_at ? Date.parse(h.created_at) : Number.NaN;
      const updatedTs = h.updated_at ? Date.parse(h.updated_at) : Number.NaN;
      if (Number.isNaN(createdTs) || Number.isNaN(updatedTs)) return false;
      if (Math.min(createdTs, updatedTs) < minRecencyTs) return false;
    }
    // Gate 3: source of truth — refuse the whole fact, don't strip patterns.
    if (scanContent(h.content) !== null) return false;
    return true;
  });
  return { hits, raw_matches: raw.length };
}
