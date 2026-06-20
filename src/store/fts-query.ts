const FTS5_OPERATOR_PATTERN = /\b(OR|AND|NOT|NEAR)\b/;
const FTS5_TOKEN_PATTERN = /"([^"]*)"|(\S+)/g;
const NATURAL_LANGUAGE_CONNECTORS = new Set(['and', 'or', 'not', 'near']);

export function hasExplicitFts5Operator(query: string): boolean {
  return FTS5_OPERATOR_PATTERN.test(query.trim());
}

function collectNaturalLanguageTerms(query: string): string[] {
  const terms: string[] = [];

  for (const match of query.matchAll(FTS5_TOKEN_PATTERN)) {
    const phrase = match[1];
    const term = match[2];
    if (phrase === undefined && term && NATURAL_LANGUAGE_CONNECTORS.has(term.toLowerCase())) {
      continue;
    }

    const rawValue = phrase ?? term ?? '';
    if (rawValue.length > 0) terms.push(rawValue);
  }

  return terms;
}

/**
 * Normalize natural-language search input into an FTS5 query.
 * Plain terms become individually quoted for implicit AND matching.
 * Explicit quoted phrases are preserved, connector stopwords are ignored in
 * natural-language mode, and raw uppercase FTS5 operators pass through.
 */
export function normalizeFts5Query(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length === 0) return '';

  if (hasExplicitFts5Operator(trimmed)) {
    return trimmed;
  }

  return collectNaturalLanguageTerms(trimmed)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' ');
}

/**
 * Build a broader fallback query for natural-language searches.
 * Returns null for explicit operator queries or when the input is already a
 * single searchable term.
 */
export function buildFallbackFts5Query(query: string): string | null {
  const trimmed = query.trim();
  if (trimmed.length === 0 || hasExplicitFts5Operator(trimmed)) {
    return null;
  }

  const terms = collectNaturalLanguageTerms(trimmed);
  if (terms.length <= 1) {
    return null;
  }

  return terms
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' OR ');
}

export function isFts5QueryError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('fts5') || msg.includes('unterminated string');
}
