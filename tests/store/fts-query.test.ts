import { describe, it } from "node:test";
import assert from "node:assert";
import {
	buildFallbackFts5Query,
	collectSignificantSearchTerms,
	normalizeFts5Query,
	passesTermHitFilter,
} from "../../src/store/fts-query.js";

describe("fts-query", () => {
	it("strips stopwords from natural-language normalize", () => {
		assert.strictEqual(normalizeFts5Query("gpu and issue"), '"gpu" "issue"');
		assert.strictEqual(normalizeFts5Query("memory search related context"), "");
	});

	it("keeps significant entity terms", () => {
		assert.deepStrictEqual(collectSignificantSearchTerms("WebVPN stampPDF"), [
			"WebVPN",
			"stampPDF",
		]);
		assert.strictEqual(
			normalizeFts5Query("WebVPN stampPDF"),
			'"WebVPN" "stampPDF"',
		);
	});

	it("builds OR fallback only over significant terms", () => {
		assert.strictEqual(
			buildFallbackFts5Query("name identity Naruto"),
			'"name" OR "identity" OR "Naruto"',
		);
		assert.strictEqual(buildFallbackFts5Query("memory search"), null);
		assert.strictEqual(buildFallbackFts5Query("pnpm"), null);
	});

	it("preserves explicit operator queries", () => {
		assert.strictEqual(normalizeFts5Query("pnpm OR AEST"), "pnpm OR AEST");
		assert.strictEqual(buildFallbackFts5Query("pnpm OR AEST"), null);
	});

	it("applies term-hit ratio filter for OR candidates", () => {
		assert.strictEqual(
			passesTermHitFilter("Naruto is the user name", [
				"name",
				"identity",
				"Naruto",
			]),
			true,
		);
		assert.strictEqual(
			passesTermHitFilter("only identity mentioned", [
				"name",
				"identity",
				"Naruto",
			]),
			false,
		);
		assert.strictEqual(
			passesTermHitFilter("WebVPN stampPDF flow", ["WebVPN", "stampPDF"]),
			true,
		);
		assert.strictEqual(
			passesTermHitFilter("WebVPN only", ["WebVPN", "stampPDF"]),
			false,
		);
	});
});
