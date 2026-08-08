import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldWarnAutoConsolidationFailure } from "../src/auto-consolidation-warning.js";

describe("shouldWarnAutoConsolidationFailure", () => {
  it("warns for failed consolidation by default", () => {
    assert.strictEqual(
      shouldWarnAutoConsolidationFailure(true, false),
      true,
    );
  });

  it("suppresses only the session warning when disabled", () => {
    assert.strictEqual(
      shouldWarnAutoConsolidationFailure(false, false),
      false,
    );
  });

  it("never warns for a successful consolidation", () => {
    assert.strictEqual(
      shouldWarnAutoConsolidationFailure(true, true),
      false,
    );
    assert.strictEqual(
      shouldWarnAutoConsolidationFailure(false, true),
      false,
    );
  });
});
