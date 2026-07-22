const FTS5_OPERATOR_PATTERN = /\b(OR|AND|NOT|NEAR)\b/;
const FTS5_TOKEN_PATTERN = /"([^"]*)"|(\S+)/g;
const NATURAL_LANGUAGE_CONNECTORS = new Set(["and", "or", "not", "near"]);

/**
 * High-frequency NL glue that almost never disambiguates memories/sessions.
 * Filtered before FTS MATCH so abstract agent queries don't OR-explode.
 */
const NATURAL_LANGUAGE_STOPWORDS = new Set([
	// English glue / meta
	"a",
	"an",
	"the",
	"this",
	"that",
	"these",
	"those",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"am",
	"do",
	"does",
	"did",
	"done",
	"have",
	"has",
	"had",
	"having",
	"will",
	"would",
	"should",
	"could",
	"can",
	"may",
	"might",
	"must",
	"shall",
	"to",
	"of",
	"in",
	"on",
	"at",
	"for",
	"from",
	"by",
	"with",
	"about",
	"into",
	"through",
	"during",
	"before",
	"after",
	"above",
	"below",
	"between",
	"under",
	"again",
	"further",
	"then",
	"once",
	"here",
	"there",
	"when",
	"where",
	"why",
	"how",
	"all",
	"each",
	"every",
	"both",
	"few",
	"more",
	"most",
	"other",
	"some",
	"such",
	"no",
	"nor",
	"not",
	"only",
	"own",
	"same",
	"so",
	"than",
	"too",
	"very",
	"just",
	"also",
	"and",
	"or",
	"but",
	"if",
	"because",
	"as",
	"until",
	"while",
	"of",
	"what",
	"which",
	"who",
	"whom",
	"whose",
	"any",
	"your",
	"you",
	"i",
	"me",
	"my",
	"we",
	"our",
	"they",
	"them",
	"their",
	"it",
	"its",
	"please",
	"help",
	"need",
	"want",
	"know",
	"find",
	"look",
	"looking",
	"show",
	"tell",
	"give",
	"get",
	"got",
	"using",
	"use",
	"used",
	"thing",
	"things",
	"something",
	"anything",
	"everything",
	"nothing",
	"stuff",
	"info",
	"information",
	"context",
	"related",
	"relevant",
	"current",
	"conversation",
	"dialogue",
	"chat",
	"question",
	"answer",
	"query",
	"result",
	"results",
	"matching",
	"match",
	"search",
	"searching",
	"searched",
	"memory",
	"memories",
	"remember",
	// Chinese glue / meta (common agent NL)
	"的",
	"了",
	"吗",
	"呢",
	"啊",
	"吧",
	"呀",
	"嘛",
	"么",
	"之",
	"与",
	"和",
	"或",
	"及",
	"在",
	"是",
	"有",
	"没",
	"没有",
	"不",
	"也",
	"都",
	"就",
	"还",
	"很",
	"太",
	"更",
	"最",
	"比",
	"被",
	"把",
	"让",
	"给",
	"对",
	"从",
	"到",
	"为",
	"以",
	"而",
	"但",
	"如果",
	"因为",
	"所以",
	"然后",
	"以及",
	"或者",
	"什么",
	"怎么",
	"怎样",
	"为何",
	"为什么",
	"哪里",
	"哪个",
	"哪些",
	"多少",
	"如何",
	"是否",
	"可否",
	"能否",
	"这个",
	"那个",
	"这些",
	"那些",
	"一个",
	"一些",
	"一下",
	"一点",
	"一起",
	"自己",
	"我们",
	"你们",
	"他们",
	"大家",
	"帮我",
	"帮忙",
	"请问",
	"我想",
	"我要",
	"需要",
	"知道",
	"了解",
	"看看",
	"查一下",
	"查查",
	"找找",
	"告诉",
	"说明",
	"解释",
	"关于",
	"相关",
	"有关",
	"当前",
	"现在",
	"对话",
	"会话",
	"上下文",
	"问题",
	"答案",
	"结果",
	"匹配",
	"搜索",
	"检索",
	"查询",
	"查找",
	"记忆",
	"内容",
	"东西",
	"事项",
	"情况",
	"无效",
	"有效",
	"无关",
	"有关的",
	"很多",
	"许多",
	"大量",
	"一些",
]);

export function hasExplicitFts5Operator(query: string): boolean {
	return FTS5_OPERATOR_PATTERN.test(query.trim());
}

function isCjkHeavy(term: string): boolean {
	const cjk = term.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g);
	if (!cjk) return false;
	return cjk.length >= Math.ceil(term.length * 0.5);
}

/**
 * Drop NL stopwords and tokens that are too weak to disambiguate FTS hits.
 * Quoted phrases are kept even if short.
 */
export function isSignificantSearchTerm(
	term: string,
	options: { quoted?: boolean } = {},
): boolean {
	const trimmed = term.trim();
	if (!trimmed) return false;

	if (options.quoted) {
		return trimmed.length > 0;
	}

	const lower = trimmed.toLowerCase();
	if (
		NATURAL_LANGUAGE_STOPWORDS.has(lower) ||
		NATURAL_LANGUAGE_STOPWORDS.has(trimmed)
	) {
		return false;
	}

	// Pure punctuation / symbols
	if (/^[\p{P}\p{S}]+$/u.test(trimmed)) {
		return false;
	}

	if (isCjkHeavy(trimmed)) {
		// Single CJK char is almost always noise under unicode61 whole-run tokenization
		return Array.from(trimmed).length >= 2;
	}

	// Latin / numeric tokens: require length >= 3 (drops "to", "is", ids like "a1")
	if (/^[a-z0-9][-a-z0-9_.]*$/i.test(trimmed)) {
		return trimmed.length >= 3;
	}

	return trimmed.length >= 2;
}

function collectNaturalLanguageTerms(
	query: string,
	options: { significantOnly?: boolean } = {},
): string[] {
	const terms: string[] = [];
	const significantOnly = options.significantOnly ?? false;

	for (const match of query.matchAll(FTS5_TOKEN_PATTERN)) {
		const phrase = match[1];
		const term = match[2];
		const quoted = phrase !== undefined;

		if (
			!quoted &&
			term &&
			NATURAL_LANGUAGE_CONNECTORS.has(term.toLowerCase())
		) {
			continue;
		}

		const rawValue = (phrase ?? term ?? "").trim();
		if (!rawValue) continue;

		if (significantOnly && !isSignificantSearchTerm(rawValue, { quoted })) {
			continue;
		}

		terms.push(rawValue);
	}

	return terms;
}

/**
 * Significant terms used for FTS + post-filtering.
 * Prefer these over raw whitespace splits when ranking OR fallback hits.
 */
export function collectSignificantSearchTerms(query: string): string[] {
	if (hasExplicitFts5Operator(query.trim())) {
		return [];
	}
	return collectNaturalLanguageTerms(query, { significantOnly: true });
}

function quoteFtsTerm(term: string): string {
	return `"${term.replace(/"/g, '""')}"`;
}

/**
 * Normalize natural-language search input into an FTS5 query.
 * Plain terms become individually quoted for implicit AND matching.
 * Explicit quoted phrases are preserved, connector/stopwords are ignored in
 * natural-language mode, and raw uppercase FTS5 operators pass through.
 */
export function normalizeFts5Query(query: string): string {
	const trimmed = query.trim();
	if (trimmed.length === 0) return "";

	if (hasExplicitFts5Operator(trimmed)) {
		return trimmed;
	}

	const significant = collectNaturalLanguageTerms(trimmed, {
		significantOnly: true,
	});
	if (significant.length > 0) {
		return significant.map(quoteFtsTerm).join(" ");
	}

	// All-stopword / glue-only NL (e.g. "memory search 检索 无关"): do not MATCH.
	// Returning empty avoids ranking long memories that casually mention "memory".
	// For intentional operator queries, hasExplicitFts5Operator path above still works.
	return "";
}

/**
 * Build a broader fallback query for natural-language searches.
 * Uses only significant terms and requires enough of them to OR.
 * Returns null for explicit operator queries or when OR would not help.
 */
export function buildFallbackFts5Query(query: string): string | null {
	const trimmed = query.trim();
	if (trimmed.length === 0 || hasExplicitFts5Operator(trimmed)) {
		return null;
	}

	const terms = collectNaturalLanguageTerms(trimmed, { significantOnly: true });
	// Need at least 2 significant terms; single-term OR is identical to AND.
	// With 3+ terms OR is still useful, but caller must post-filter by hit ratio.
	if (terms.length <= 1) {
		return null;
	}

	return terms.map(quoteFtsTerm).join(" OR ");
}

/**
 * Minimum fraction of significant query terms a document must contain
 * (case-insensitive substring) to keep an OR-fallback hit.
 */
export function minTermHitRatio(termCount: number): number {
	if (termCount <= 1) return 1;
	if (termCount === 2) return 1; // both terms required when only two significant words
	if (termCount === 3) return 2 / 3;
	return 0.5;
}

export function countTermHitsInText(text: string, terms: string[]): number {
	if (!text || terms.length === 0) return 0;
	const haystack = text.toLowerCase();
	let hits = 0;
	for (const term of terms) {
		const needle = term.toLowerCase();
		if (!needle) continue;
		if (haystack.includes(needle)) hits += 1;
	}
	return hits;
}

export function passesTermHitFilter(text: string, terms: string[]): boolean {
	if (terms.length === 0) return true;
	const hits = countTermHitsInText(text, terms);
	const needed = Math.ceil(terms.length * minTermHitRatio(terms.length));
	return hits >= needed;
}

export function isFts5QueryError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const msg = err.message.toLowerCase();
	return msg.includes("fts5") || msg.includes("unterminated string");
}
