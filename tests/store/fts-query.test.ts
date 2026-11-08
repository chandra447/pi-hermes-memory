import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFts5Query,
  buildFallbackFts5Query,
  hasExplicitFts5Operator,
  normalizeNaturalLanguageFts5Query,
  buildNaturalLanguageFallbackQuery,
  isFts5QueryError,
} from '../../src/store/fts-query.js';

describe('fts-query', () => {
  describe('stop word filtering', () => {
    it('filters filler words but keeps meaningful terms', () => {
      const q = normalizeFts5Query('how to fix the authentication bug');
      assert.ok(q.includes('"authentication"'), 'keeps meaningful term');
      assert.ok(q.includes('"bug"'), 'keeps meaningful term');
      assert.ok(!q.includes('"how"'), 'filters "how"');
      assert.ok(!q.includes('"to"'), 'filters "to"');
      assert.ok(!q.includes('"the"'), 'filters "the"');
    });

    it('returns empty string when every term is a stop word', () => {
      assert.strictEqual(normalizeFts5Query('the a is was were'), '');
      assert.strictEqual(normalizeFts5Query('for in on'), '');
    });

    it('keeps quoted phrases intact even when they contain stop words', () => {
      const q = normalizeNaturalLanguageFts5Query('"the quick brown fox" jumps');
      assert.ok(q.includes('"the quick brown fox"'));
      assert.ok(q.includes('"jumps"'));
    });

    it('normalizes case-insensitively against the stop word list', () => {
      const q = normalizeFts5Query('The QUICK brown Fox');
      assert.ok(q.includes('"QUICK"'));
      assert.ok(q.includes('"Fox"'));
      assert.ok(!q.includes('"The"'));
    });
  });

  describe('fallback queries', () => {
    it('builds an OR fallback for multi-term natural language queries', () => {
      const fb = buildFallbackFts5Query('authentication bug fix');
      assert.ok(fb);
      assert.ok(fb.includes('OR'));
      assert.ok(fb.includes('"authentication"'));
      assert.ok(fb.includes('"bug"'));
    });

    it('returns null when there are not enough meaningful terms', () => {
      assert.strictEqual(buildFallbackFts5Query('auth'), null);
      assert.strictEqual(buildFallbackFts5Query('the a'), null);
    });

    it('returns null for explicit operator queries', () => {
      assert.strictEqual(buildFallbackFts5Query('auth OR database'), null);
    });
  });

  describe('operator handling', () => {
    it('detects explicit FTS5 operators', () => {
      assert.ok(hasExplicitFts5Operator('auth OR database'));
      assert.ok(hasExplicitFts5Operator('"auth bug" AND database'));
      assert.ok(!hasExplicitFts5Operator('auth database'));
    });

    it('preserves explicit operator queries verbatim in normalizeFts5Query', () => {
      assert.strictEqual(normalizeFts5Query('auth OR database'), 'auth OR database');
    });

    it('quotes a hyphenated bareword instead of letting FTS5 read it as syntax (#307)', () => {
      // FTS5 parses `policy-only` as column `policy` minus `only` and fails the
      // whole statement with "no such column: only"; the term has to stay data
      // while the operator stays syntax.
      assert.strictEqual(normalizeFts5Query('alpha OR policy-only'), 'alpha OR "policy-only"');
      assert.strictEqual(normalizeFts5Query('alpha NOT develop-tdd'), 'alpha NOT "develop-tdd"');
      assert.strictEqual(normalizeFts5Query('PA-14 AND 2-5'), '"PA-14" AND "2-5"');
      assert.strictEqual(normalizeFts5Query('version-2.1 OR alpha'), '"version-2.1" OR alpha');
    });

    it('leaves query syntax the caller wrote deliberately untouched (#307)', () => {
      // Already-quoted phrases, column filters, NEAR groups, prefix markers and
      // a leading hyphen are syntax, not data; quoting them would change the
      // query the caller asked for.
      assert.strictEqual(normalizeFts5Query('"policy-only" OR alpha'), '"policy-only" OR alpha');
      assert.strictEqual(normalizeFts5Query('alpha OR content:policy-only'), 'alpha OR content:policy-only');
      assert.strictEqual(normalizeFts5Query('NEAR(policy-only alpha, 5)'), 'NEAR(policy-only alpha, 5)');
      assert.strictEqual(normalizeFts5Query('policy-only* OR alpha'), 'policy-only* OR alpha');
      assert.strictEqual(normalizeFts5Query('alpha OR -policy-only'), 'alpha OR -policy-only');
    });
  });

  describe('natural language recovery', () => {
    it('normalizes uppercase operator words as natural language', () => {
      // 'DO' is a stop word and 'NOT' a natural-language connector, so only
      // the two meaningful terms survive, quoted for implicit AND matching.
      assert.strictEqual(normalizeNaturalLanguageFts5Query('DO NOT USE FIND'), '"USE" "FIND"');
    });

    it('keeps intent-bearing words out of the stop list (can/need/off/like/get)', () => {
      // These words frequently carry the actual search intent ("can the app
      // start", "need to restart", "like this", "get the build passing"), so
      // they must survive normalization rather than be silently dropped.
      assert.strictEqual(
        normalizeFts5Query('can need off like get'),
        '"can" "need" "off" "like" "get"',
      );
    });

    it('builds a natural language OR fallback ignoring operator detection', () => {
      const fb = buildNaturalLanguageFallbackQuery('DO NOT USE FIND');
      assert.ok(fb && fb.includes('OR'));
    });
  });

  describe('isFts5QueryError', () => {
    it('detects genuine FTS5 query/index failure messages', () => {
      assert.ok(isFts5QueryError(new Error('fts5: syntax error near "AND"')), 'fts5');
      assert.ok(isFts5QueryError(new Error('fts5: unterminated string')), 'unterminated string');
      assert.ok(isFts5QueryError(new Error('unterminated string constant in FTS5 query')), 'unterminated string constant');
    });

    it('rejects corruption signals so DatabaseManager recovery still runs (#186)', () => {
      // These are corruption/recovery signals, NOT recoverable FTS query errors.
      // Swallowing them would suppress quarantine/rebuild of a corrupt database.
      assert.ok(!isFts5QueryError(new Error('database disk image is malformed')), 'malformed is corruption, not FTS');
      assert.ok(!isFts5QueryError(new Error('SQL logic error')), 'sql logic error is too broad to swallow');
      assert.ok(!isFts5QueryError(new Error('file is not a database')), 'notadb is corruption, not FTS');
    });

    it('rejects unrelated errors', () => {
      assert.ok(!isFts5QueryError(new Error('disk full')));
      assert.ok(!isFts5QueryError('string, not an Error'));
    });
  });
});
