/**
 * Re-export shim — the clean-hit layer now lives in `src/shared/` (v2
 * shared-memory lift, spine AD-7: the gate is a single implementation shared
 * by the local providers and the hub). Existing importers keep working; new
 * code should import from `src/shared/clean-hit.js`.
 */

export {
  cleanHit,
  type ProviderSearchOptions,
  type ProviderSearchHit,
  type ProviderSearchResult,
  type RecallableProvider,
} from '../../shared/clean-hit.js';
