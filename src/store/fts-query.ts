const FTS5_OPERATOR_PATTERN = /\b(OR|AND|NOT|NEAR)\b/;
const FTS5_TOKEN_PATTERN = /"([^"]*)"|(\S+)/g;
const NATURAL_LANGUAGE_CONNECTORS = new Set(['and', 'or', 'not', 'near']);

// Common English stop words that add noise to FTS5 searches. They are silently
// dropped from natural-language queries so common filler words cannot dominate
// the FTS5 ranking or produce misleading "AND"-style misses.
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'shall', 'can', 'need', 'dare', 'ought', 'used',
  'i', 'me', 'my', 'mine', 'we', 'our', 'ours', 'you', 'your', 'yours',
  'he', 'him', 'his', 'she', 'her', 'hers', 'it', 'its', 'they', 'them',
  'their', 'theirs', 'that', 'this', 'these', 'those', 'what', 'which',
  'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 's',
  't', 'just', 'don', 'now', 'about', 'above', 'after', 'again', 'against',
  'am', 'at', 'before', 'behind', 'below', 'between', 'by', 'during',
  'from', 'further', 'into', 'like', 'off', 'over', 'per', 'through',
  'throughout', 'till', 'to', 'under', 'until', 'up', 'upon', 'via', 'with',
  'within', 'without', 'as', 'if', 'or', 'but', 'and', 'out', 'of',
  'for', 'in', 'on', 'any', 'get', 'got', 'here', 'there',
]);

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
    // Skip high-frequency stop words so they cannot dominate FTS5 ranking.
    if (phrase === undefined && term && STOP_WORDS.has(term.toLowerCase())) {
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

function quoteTerms(terms: string[], separator: string): string {
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(separator);
}

/**
 * Normalize a query as natural language even when it contains uppercase
 * operator words. Queries like "DO NOT USE FIND /" are passed through as raw
 * FTS5 syntax by normalizeFts5Query; when that raw form fails to parse, this
 * produces the quoted-term form to retry with.
 */
export function normalizeNaturalLanguageFts5Query(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length === 0) return '';

  return quoteTerms(collectNaturalLanguageTerms(trimmed), ' ');
}

/**
 * Build the broader OR fallback for the same recovery path, ignoring
 * operator detection.
 */
export function buildNaturalLanguageFallbackQuery(query: string): string | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;

  const terms = collectNaturalLanguageTerms(trimmed);
  if (terms.length <= 1) return null;

  return quoteTerms(terms, ' OR ');
}

export function isFts5QueryError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('fts5') ||
    msg.includes('unterminated string') ||
    msg.includes('malformed') ||
    msg.includes('sql logic error');
}
