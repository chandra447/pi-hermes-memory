import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRetryableLoader } from "../src/deferred-loader.js";

describe("retryable deferred loader", () => {
  it("coalesces concurrent first uses and caches success", async () => {
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const load = createRetryableLoader(async () => {
      calls++;
      await release.promise;
      return { ready: true };
    });

    const first = load();
    const second = load();
    assert.strictEqual(first, second);
    release.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.strictEqual(a, b);
    assert.strictEqual(await load(), a);
    assert.equal(calls, 1);
  });

  it("clears a rejected promise so a later use retries", async () => {
    let calls = 0;
    const load = createRetryableLoader(async () => {
      if (++calls === 1) throw new Error("transient import failure");
      return "loaded";
    });

    await assert.rejects(load(), /transient import failure/);
    assert.equal(await load(), "loaded");
    assert.equal(calls, 2);
  });
});
