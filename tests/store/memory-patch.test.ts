import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { MemoryStore } from "../../src/store/memory-store.js";
import type { MemoryConfig } from "../../src/types.js";
import { ENTRY_DELIMITER } from "../../src/constants.js";

type Target = "memory" | "user" | "failure";
const today = new Date().toISOString().split("T")[0];

function entry(text: string, project?: string, created = "2020-01-01", last = created): string {
  const scope = project ? `, project64=${Buffer.from(project).toString("base64url")}` : "";
  return `${text} <!-- created=${created}, last=${last}${scope} -->`;
}

async function fixture(target: Target, entries: string[], run: (store: MemoryStore, file: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-patch-"));
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

it("patches one sentence inside a one-line multi-sentence entry, preserving created and sibling facts (#314)", async () => {
  const whole = "Uses pnpm for installs. Runs tests via vitest. Deploys on Fridays.";
  await fixture("memory", [entry(whole)], async (store, file) => {
    const result = await store.patch("memory", "Runs tests via vitest", "Runs tests via node --test");
    assert.equal(result.success, true);
    const raw = store.getRawEntriesForSync("memory")[0];
    assert.match(raw, /Uses pnpm for installs\. Runs tests via node --test\. Deploys on Fridays\./);
    assert.match(raw, new RegExp(`created=2020-01-01, last=${today}`), "created is preserved, last is bumped");
    assert.equal(await fs.readFile(file, "utf8"), raw);
  });
});

it("refuses when no entry matches, leaving the file byte-identical", async () => {
  await fixture("user", [entry("Prefers concise answers.")], async (store, file) => {
    const before = await fs.readFile(file, "utf8");
    const result = await store.patch("user", "verbose", "terse");
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /No entry matched/);
    assert.equal(await fs.readFile(file, "utf8"), before);
  });
});

it("refuses when several entries match the fragment", async () => {
  await fixture("memory", [entry("Prefer short answers."), entry("Prefer bullet lists.")], async (store, file) => {
    const before = await fs.readFile(file, "utf8");
    const result = await store.patch("memory", "Prefer", "Require");
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /Multiple entries matched/);
    assert.equal(await fs.readFile(file, "utf8"), before);
  });
});

it("refuses when the fragment occurs twice inside the matched entry", async () => {
  const whole = "The pipeline uses pnpm. The docs also say pnpm everywhere.";
  await fixture("memory", [entry(whole)], async (store, file) => {
    const before = await fs.readFile(file, "utf8");
    const result = await store.patch("memory", "pnpm", "bun");
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /more than once/);
    assert.equal(await fs.readFile(file, "utf8"), before);
  });
});

it("an empty new_text deletes only the fragment", async () => {
  const whole = "Uses pnpm for installs. Also keeps a node_modules cache. Deploys on Fridays.";
  await fixture("memory", [entry(whole)], async (store) => {
    const result = await store.patch("memory", "Also keeps a node_modules cache. ", "");
    assert.equal(result.success, true);
    const raw = store.getRawEntriesForSync("memory")[0];
    assert.match(raw, /Uses pnpm for installs\. Deploys on Fridays\./);
    assert.match(raw, new RegExp(`created=2020-01-01`));
  });
});

it("refuses an empty result, pointing at memory_remove", async () => {
  const whole = "Only fact in this entry.";
  await fixture("memory", [entry(whole)], async (store, file) => {
    const before = await fs.readFile(file, "utf8");
    const result = await store.patch("memory", whole, "");
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /memory_remove/);
    assert.equal(await fs.readFile(file, "utf8"), before);
  });
});

it("refuses a patch that would duplicate another entry's body (#306 guard)", async () => {
  const whole = "Uses pnpm for installs. Runs tests via vitest.";
  await fixture("user", [entry(whole), entry("Runs tests via vitest.")], async (store, file) => {
    const before = await fs.readFile(file, "utf8");
    const result = await store.patch("user", "Uses pnpm for installs. ", "");
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /duplicate/i);
    assert.equal(await fs.readFile(file, "utf8"), before);
  });
});

it("patches one line of a multi-line entry and accepts a multi-line fragment", async () => {
  const whole = "Setup notes:\ninstall with pnpm\nrun with vitest";
  await fixture("memory", [entry(whole)], async (store) => {
    assert.equal((await store.patch("memory", "run with vitest", "run with node --test")).success, true);
    let raw = store.getRawEntriesForSync("memory")[0];
    assert.match(raw, /Setup notes:\ninstall with pnpm\nrun with node --test/);

    const twoLine = await store.patch("memory", "install with pnpm\nrun with node --test", "install via corepack\nrun via the repo script");
    assert.equal(twoLine.success, true, "a fragment may span lines");
    raw = store.getRawEntriesForSync("memory")[0];
    assert.match(raw, /Setup notes:\ninstall via corepack\nrun via the repo script/);
  });
});

it("failure target: preserves the category tag and patches scoped copies together", async () => {
  const tagged = "[tool-quirk] Heavy loops block the UI thread.";
  await fixture("failure", [entry(tagged, "a"), entry(tagged, "b"), entry("[failure] Unrelated note.")], async (store) => {
    const result = await store.patch("failure", "block the UI thread", "freeze the UI thread");
    assert.equal(result.success, true, "distinct scoped copies patch together, like replace");
    const texts = store.getAllFailureEntries();
    assert.equal(texts.filter((t) => t.includes("freeze the UI thread")).length, 2);
    assert.ok(texts.every((t) => t.includes("[")), "tags survive");
    assert.equal(store.getRawEntriesForSync("failure").filter((r) => r.includes("created=2020-01-01")).length, 3);
  });
});

it("accepts a pasted search-result line as old_text", async () => {
  await fixture("memory", [entry("Uses pnpm for installs.")], async (store) => {
    const result = await store.patch("memory", "[target=memory] Uses pnpm", "Uses bun");
    assert.equal(result.success, true);
    assert.match(store.getRawEntriesForSync("memory")[0], /Uses bun/);
  });
});

it("treats replacement special patterns literally and permits a no-op patch", async () => {
  const whole = "Deploys with a $& dollar pattern.";
  await fixture("memory", [entry(whole)], async (store) => {
    const result = await store.patch("memory", "dollar", "$` backtick");
    assert.equal(result.success, true);
    assert.match(store.getRawEntriesForSync("memory")[0], /\$& dollar pattern\.|\$` backtick/);
    assert.ok(store.getRawEntriesForSync("memory")[0].includes("$`"), "replacement patterns must stay literal");

    assert.equal((await store.patch("memory", "$` backtick", "$` backtick")).success, true);
  });
});
