/**
 * Standing instructions (#121) — the always-injected, user-authored block.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StandingInstructions } from "../../src/store/standing-instructions.js";
import { STANDING_MAX_CHARS, STANDING_MAX_ENTRIES } from "../../src/constants.js";

let root = "";
let filePath = "";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-standing-"));
  filePath = path.join(root, "STANDING.md");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function loadedStore(contents?: string): Promise<StandingInstructions> {
  if (contents !== undefined) await fs.writeFile(filePath, contents, "utf-8");
  const store = new StandingInstructions(filePath);
  await store.load();
  return store;
}

describe("StandingInstructions parsing", () => {
  it("treats a hand-edited Markdown file as one instruction per line", async () => {
    const store = await loadedStore([
      "# my rules",
      "",
      "- never run find / or other root-wide searches",
      "* always use pnpm",
      "   scope   searches   to known directories   ",
      "",
    ].join("\n"));

    assert.deepStrictEqual(store.list(), [
      "never run find / or other root-wide searches",
      "always use pnpm",
      "scope searches to known directories",
    ]);
  });

  it("starts empty when the file does not exist yet", async () => {
    const store = await loadedStore();
    assert.deepStrictEqual(store.list(), []);
    assert.strictEqual(store.formatForSystemPrompt(), "");
  });
});

describe("StandingInstructions writes", () => {
  it("persists a pinned instruction and reloads it", async () => {
    const store = await loadedStore();
    const result = await store.add("  never run find / ");

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.instructions, ["never run find /"]);
    assert.strictEqual(await fs.readFile(filePath, "utf-8"), "never run find /\n");

    const reloaded = await loadedStore();
    assert.deepStrictEqual(reloaded.list(), ["never run find /"]);
  });

  it("rejects a duplicate regardless of casing", async () => {
    const store = await loadedStore();
    await store.add("always use pnpm");
    const duplicate = await store.add("Always Use Pnpm");

    assert.strictEqual(duplicate.success, false);
    assert.match(duplicate.error!, /already pinned/i);
    assert.strictEqual(store.list().length, 1);
  });

  it("refuses content the memory content scanner blocks", async () => {
    const store = await loadedStore();
    const result = await store.add("always export ANTHROPIC_API_KEY before running the build");

    assert.strictEqual(result.success, false);
    assert.match(result.error!, /Blocked:/);
    assert.deepStrictEqual(store.list(), []);
  });

  it("refuses to exceed the entry cap", async () => {
    const store = await loadedStore();
    for (let i = 0; i < STANDING_MAX_ENTRIES; i++) {
      assert.strictEqual((await store.add(`rule number ${i}`)).success, true);
    }

    const overflow = await store.add("one rule too many");
    assert.strictEqual(overflow.success, false);
    assert.match(overflow.error!, new RegExp(`capped at ${STANDING_MAX_ENTRIES} entries`));
    assert.strictEqual(store.list().length, STANDING_MAX_ENTRIES);
  });

  it("refuses to exceed the character budget", async () => {
    const store = await loadedStore();
    const result = await store.add("x".repeat(STANDING_MAX_CHARS + 1));

    assert.strictEqual(result.success, false);
    assert.match(result.error!, new RegExp(`capped at ${STANDING_MAX_CHARS} characters`));
    assert.deepStrictEqual(store.list(), []);
  });

  it("removes by position and rejects an out-of-range one", async () => {
    const store = await loadedStore();
    await store.add("first rule");
    await store.add("second rule");

    const removed = await store.remove(1);
    assert.strictEqual(removed.success, true);
    assert.deepStrictEqual(store.list(), ["second rule"]);

    const bad = await store.remove(5);
    assert.strictEqual(bad.success, false);
    assert.match(bad.error!, /between 1 and 1/);
  });

  it("clears every instruction", async () => {
    const store = await loadedStore();
    await store.add("first rule");
    await store.add("second rule");

    const cleared = await store.clear();
    assert.strictEqual(cleared.success, true);
    assert.deepStrictEqual(store.list(), []);
    assert.strictEqual(await fs.readFile(filePath, "utf-8"), "");
  });
});

describe("StandingInstructions rendering", () => {
  it("renders a numbered, fenced block that reads as user directive", async () => {
    const store = await loadedStore("never run find /\nalways use pnpm\n");
    const rendered = store.render();

    assert.match(rendered.block, /^<standing-instructions>/);
    assert.match(rendered.block, /<\/standing-instructions>$/);
    assert.match(rendered.block, /1\. never run find \//);
    assert.match(rendered.block, /2\. always use pnpm/);
    assert.match(rendered.block, /direct\s+instructions from the user, not recalled context/);
    assert.strictEqual(rendered.injectedCount, 2);
    assert.strictEqual(rendered.omittedCount, 0);
  });

  it("truncates a hand-edited over-budget file loudly rather than silently", async () => {
    // Written straight to disk: the /memory-pin cap cannot catch this path.
    const long = Array.from({ length: 6 }, (_, i) => `${i} ${"y".repeat(450)}`);
    const store = await loadedStore(`${long.join("\n")}\n`);
    const rendered = store.render();

    assert.ok(rendered.injectedCount > 0, "some rules still make it in");
    assert.ok(rendered.omittedCount > 0, "the rest are dropped");
    assert.strictEqual(rendered.injectedCount + rendered.omittedCount, 6);
    assert.match(rendered.block, /could not be shown/);
    assert.match(rendered.block, new RegExp(`${STANDING_MAX_CHARS}-character injection budget`));
    assert.ok(
      rendered.block.length < STANDING_MAX_CHARS + 1000,
      "the block must stay near its budget, not blow past it",
    );
  });

  it("renders nothing when no instructions are pinned", async () => {
    const store = await loadedStore("# only a comment\n");
    assert.deepStrictEqual(store.render(), { block: "", injectedCount: 0, omittedCount: 0 });
  });
});
