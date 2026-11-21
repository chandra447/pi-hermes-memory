export function normalizeMemoryLookupText(text: string): string {
  let normalized = text.trim();
  if (!normalized) return "";

  const firstNonEmptyLine = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstNonEmptyLine) normalized = firstNonEmptyLine;

  // Current memory_search results use a URL-encoded scope token so arbitrary
  // project names cannot terminate the prefix early.
  normalized = normalized.replace(
    /^\S+\s+scope=(?:global|project:[^\s]+)\s+\[target=(?:memory|user|project|failure)\]\s+/u,
    "",
  );
  normalized = normalized.replace(/^\S+\s+\[[^\]]+\]\s+/u, "");
  // memory_search labels each result with its mutation target after the scope.
  // Keep copied search lines usable as replace/remove lookup text.
  normalized = normalized.replace(/^\[target=(?:memory|user|project|failure)\]\s+/u, "");
  normalized = normalized.replace(/^(\[[^\]]+\])\s+\1(\s+|$)/, "$1 ");

  return normalized.trim();
}

/**
 * Normalize lookup text for memory_patch (#314).
 *
 * Same pasted-line cleanup as normalizeMemoryLookupText (search-result scope
 * prefixes and mutation-target labels are stripped), but internal newlines
 * are preserved: a patch fragment is an exact substring and may span lines
 * in a multi-line entry, while replace/remove keep their historical
 * first-line lookup semantics. Junk pasted around a fragment fails loudly
 * (no match) instead of being silently truncated to its first line.
 */
export function normalizePatchLookupText(text: string): string {
  let normalized = text.trim();
  if (!normalized) return "";

  normalized = normalized.replace(
    /^\S+\s+scope=(?:global|project:[^\s]+)\s+\[target=(?:memory|user|project|failure)\]\s+/u,
    "",
  );
  normalized = normalized.replace(/^\S+\s+\[[^\]]+\]\s+/u, "");
  normalized = normalized.replace(/^\[target=(?:memory|user|project|failure)\]\s+/u, "");
  normalized = normalized.replace(/^(\[[^\]]+\])\s+\1(\s+|$)/, "$1 ");

  return normalized.trim();
}
