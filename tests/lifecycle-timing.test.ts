import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  measureLifecycle,
  measureLifecycleSync,
  type LifecycleTimingOptions,
} from "../src/lifecycle-timing.js";

function timingOptions(
  times: number[],
  lines: string[],
  enabled?: boolean,
): LifecycleTimingOptions {
  return {
    ...(enabled === undefined ? {} : { enabled }),
    now: () => {
      const value = times.shift();
      assert.notEqual(value, undefined);
      return value;
    },
    log: (line) => lines.push(line),
  };
}

describe("lifecycle timing", () => {
  it("is silent and avoids reading the clock when disabled", () => {
    const lines: string[] = [];
    const result = measureLifecycleSync(
      "session-start.load",
      () => 42,
      timingOptions([], lines, false),
    );

    assert.equal(result, 42);
    assert.deepEqual(lines, []);
  });

  it("records labeled sync and async durations when PI_TIMING is enabled", async () => {
    const previous = process.env.PI_TIMING;
    process.env.PI_TIMING = "1";
    try {
      const lines: string[] = [];
      const options = timingOptions([10, 22, 30, 49], lines);

      assert.equal(measureLifecycleSync("database.open", () => "ok", options), "ok");
      assert.equal(await measureLifecycle("shutdown.flush", async () => "done", options), "done");
      assert.deepEqual(lines, [
        "[pi-hermes-memory timing] database.open: 12ms",
        "[pi-hermes-memory timing] shutdown.flush: 19ms",
      ]);
    } finally {
      if (previous === undefined) delete process.env.PI_TIMING;
      else process.env.PI_TIMING = previous;
    }
  });

  it("preserves sync and async errors while recording their durations", async () => {
    const lines: string[] = [];
    const options = timingOptions([1, 3, 5, 8], lines, true);
    const syncError = new Error("sync failure");
    const asyncError = new Error("async failure");

    assert.throws(
      () => measureLifecycleSync("backfill.callback", () => { throw syncError; }, options),
      syncError,
    );
    await assert.rejects(
      measureLifecycle("live-index.callback", async () => { throw asyncError; }, options),
      asyncError,
    );
    assert.deepEqual(lines, [
      "[pi-hermes-memory timing] backfill.callback: 2ms",
      "[pi-hermes-memory timing] live-index.callback: 3ms",
    ]);
  });
});
