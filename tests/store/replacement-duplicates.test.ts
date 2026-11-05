import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { MemoryStore } from "../../src/store/memory-store.js";
import type { MemoryConfig } from "../../src/types.js";
import { ENTRY_DELIMITER } from "../../src/constants.js";

type Target = "memory" | "user" | "failure";
type Mode = "replace" | "plan";
const original = "Prefer short answers.";
const existing = "Prefer detailed examples.";
const extra = "An unrelated fixture entry long enough that removing it makes the whole plan shrink.";
function entry(text: string, project?: string, last = "2020-01-01"): string {
  const scope = project ? `, project64=${Buffer.from(project).toString("base64url")}` : "";
  return `${text} <!-- created=2020-01-01, last=${last}${scope} -->`;
}

async function fixture(target: Target, entries: string[], run: (store: MemoryStore, file: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-replace-duplicates-"));
  try {
    const file = path.join(dir, { memory: "MEMORY.md", user: "USER.md", failure: "failures.md" }[target]);
    await fs.writeFile(file, entries.join(ENTRY_DELIMITER));
    const store = new MemoryStore({ memoryDir: dir, memoryMode: "policy-only", memoryCharLimit: 5000, userCharLimit: 5000 } as MemoryConfig);
    await store.loadFromDisk();
    await run(store, file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
function replace(store: MemoryStore, mode: Mode, target: Target, oldText: string, content: string) {
  return mode === "replace" ? store.replace(target, oldText, content)
    : store.applyMutationPlan(target, [{ action: "replace", oldText, content }]);
}

for (const mode of ["replace", "plan"] as const) {
  for (const target of ["memory", "user", "failure"] as const) {
    it(`${mode} refuses an existing ${target} body without publishing any mutation`, async () => {
      await fixture(target, [entry(original), entry(existing, undefined, "2021-01-01")], async (store, file) => {
        const before = await fs.readFile(file, "utf8");
        const raw = store.getRawEntriesForSync(target);
        const observed: string[][] = [];
        store.setMutationObserver(async (_target, entries) => { observed.push(entries); });
        const result = await replace(store, mode, target, original, `  ${existing}  `);
        assert.equal(result.success, false);
        assert.match(result.error ?? "", /duplicate/i);
        assert.deepEqual(observed, [raw]);
        assert.deepEqual(store.getRawEntriesForSync(target), raw);
        assert.equal(await fs.readFile(file, "utf8"), before);
        await store.loadFromDisk();
        assert.deepEqual(store.getRawEntriesForSync(target), raw);
        assert.equal((await store.remove(target, original)).success, true);
        assert.equal((await store.remove(target, existing)).success, true);
      });
    });
    it(`${mode} permits a ${target} no-op and then a distinct replacement`, async () => {
      await fixture(target, [entry(original), entry(existing)], async (store) => {
        assert.equal((await replace(store, mode, target, original, original)).success, true);
        assert.equal((await replace(store, mode, target, original, "Prefer diagrams.")).success, true);
        await store.loadFromDisk();
        assert.equal(store.getRawEntriesForSync(target).length, 2);
        assert.equal((await store.remove(target, "Prefer diagrams.")).success, true);
      });
    });
  }
  it(`${mode} preserves distinct project-scoped failure copies`, async () => {
    await fixture("failure", [entry(original, "a"), entry(existing, "b")], async (store) => {
      assert.equal((await replace(store, mode, "failure", original, existing)).success, true);
      await store.loadFromDisk();
      assert.equal(store.getAllFailureEntries().filter(text => text === existing).length, 2);
      assert.equal((await store.remove("failure", existing)).success, true);
    });
  });
  it(`${mode} rejects a collision in one of multiple matched failure scopes`, async () => {
    await fixture("failure", [entry(original, "a"), entry(original, "b"), entry(existing, "b")], async (store, file) => {
      const before = await fs.readFile(file, "utf8");
      assert.equal((await replace(store, mode, "failure", original, existing)).success, false);
      assert.equal(await fs.readFile(file, "utf8"), before);
    });
  });
  it(`${mode} preserves ambiguity protection for different bodies`, async () => {
    await fixture("user", [entry(original), entry(existing)], async (store) => {
      const result = await replace(store, mode, "user", "Prefer", "Prefer diagrams.");
      assert.equal(result.success, false);
      assert.match(result.error ?? "", /Multiple entries matched/);
    });
  });
}
it("a shrinking plan rolls back earlier removals when replacement would collide", async () => {
  await fixture("user", [entry(original), entry(existing), entry(extra)], async (store, file) => {
    const before = await fs.readFile(file, "utf8");
    const result = await store.applyMutationPlan("user", [
      { action: "remove", oldText: extra },
      { action: "replace", oldText: original, content: existing },
    ], { requireShrink: true });
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /duplicate/i);
    assert.equal(await fs.readFile(file, "utf8"), before);
    assert.equal(store.getRawEntriesForSync("user").length, 3);
  });
});
it("a plan may explicitly remove a conflicting entry before replacing", async () => {
  await fixture("user", [entry(original), entry(existing)], async (store) => {
    const result = await store.applyMutationPlan("user", [
      { action: "remove", oldText: existing },
      { action: "replace", oldText: original, content: existing },
    ], { requireShrink: true });
    assert.equal(result.success, true);
    await store.loadFromDisk();
    assert.deepEqual(store.getUserEntries(), [existing]);
  });
});
