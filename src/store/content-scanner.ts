/**
 * Re-export shim — the content scanner now lives in `src/shared/` (v2
 * shared-memory lift, spine AD-7: the gates are a single implementation
 * imported by both the local and the hub path). Existing importers keep
 * working; new code should import from `src/shared/content-scanner.js`.
 */

export { scanContent, scanSecrets } from '../shared/content-scanner.js';
