const FTS5_OPERATOR_PATTERN = /\b(OR|AND|NOT|NEAR)\b/;
const FTS5_TOKEN_PATTERN = /"([^"]*)"|(\S+)/g;
const NATURAL_LANGUAGE_CONNECTORS = new Set(['and', 'or', 'not', 'near']);

// A bareword FTS5 can be handed as data once quoted: letters, digits, marks,
// underscores, dots and internal hyphens. Anything carrying query syntax
// (quotes, parentheses, `*`, `:`, a leading hyphen) is left alone so column
// filters, NEAR groups and prefix queries keep their meaning.
const FTS5_QUOTABLE_BAREWORD = /^[\p{L}\p{N}\p{M}_][\p{L}\p{N}\p{M}_.-]*$/u;

// Common English stop words that add noise to FTS5 searches. They are silently
// dropped from natural-language queries so common filler words cannot dominate
// the FTS5 ranking or produce misleading "AND"-style misses. The list is
// deliberately conservative: only high-frequency function words are dropped.
// Words that frequently carry the actual search intent (can, need, off, like,
// get) stay, so "can the app start" still searches for "can".
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'shall', 'dare', 'ought', 'used',
  'i', 'me', 'my', 'mine', 'we', 'our', 'ours', 'you', 'your', 'yours',
  'he', 'him', 'his', 'she', 'her', 'hers', 'it', 'its', 'they', 'them',
  'their', 'theirs', 'that', 'this', 'these', 'those', 'what', 'which',
  'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 's',
  't', 'just', 'don', 'now', 'about', 'above', 'after', 'again', 'against',
  'am', 'at', 'before', 'behind', 'below', 'between', 'by', 'during',
  'from', 'further', 'into', 'over', 'per', 'through',
  'throughout', 'till', 'to', 'under', 'until', 'up', 'upon', 'via', 'with',
  'within', 'without', 'as', 'if', 'or', 'but', 'and', 'out', 'of',
  'for', 'in', 'on', 'any', 'got', 'here', 'there',
]);

export function hasExplicitFts5Operator(query: string): boolean {
  return FTS5_OPERATOR_PATTERN.test(query.trim());
}

/**
 * Quote barewords that carry an unquoted hyphen.
 *
 * In raw-operator mode the query is passed through so OR/AND/NOT/NEAR keep
 * working, but FTS5 reads `policy-only` as query syntax and the whole statement
 * fails with `no such column: only` (#307). Quoting the term makes it data again
 * while the operators stay syntax, so the caller keeps the semantics it asked
 * for instead of degrading to natural-language terms. `NEAR(a-b, 5)`,
 * `content:policy-only` and already-quoted phrases are deliberately untouched:
 * they either contain their own grouping or are syntax the caller asked for.
 */
function quoteFts5HyphenatedBarewords(query: string): string {
  return query.replace(FTS5_TOKEN_PATTERN, (full, phrase, term) => {
    if (phrase !== undefined || !term) return full;
    if (!term.includes('-') || !FTS5_QUOTABLE_BAREWORD.test(term)) return full;
    return `"${term.replace(/"/g, '""')}"`;
  });
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
 * natural-language mode, and raw uppercase FTS5 operators pass through — with
 * one exception: a bareword carrying an unquoted hyphen is quoted, because FTS5
 * reads it as syntax and fails the whole statement (#307).
 */
export function normalizeFts5Query(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length === 0) return '';

  if (hasExplicitFts5Operator(trimmed)) {
    return quoteFts5HyphenatedBarewords(trimmed);
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
 * Collect the raw terms of a query for literal (LIKE) fallback searches.
 * Unlike normalizeFts5Query this does NOT drop stop words — a literal
 * substring fallback is the last resort, and the original terms are what the
 * user typed. Natural-language connectors are skipped because they never
 * carry search intent.
 */
export function collectLikeTerms(query: string): string[] {
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
  // NOTE: "malformed" and "sql logic error" are intentionally NOT matched here.
  // They are corruption/recovery signals used by DatabaseManager (#186); swallowing
  // them would suppress database quarantine/rebuild. Only genuine FTS5 query/index
  // errors are considered recoverable search-path failures.
  return msg.includes('fts5') ||
    msg.includes('unterminated string');
}
