import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const modulePath = pathToFileURL(
  path.join(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src"),
    "store/atomic-lock-coordinator.ts",
  ),
).href;

// The Linux probe branch reads /proc inside a try/catch, so an injected error is
// swallowed there and the call is unobservable. Pinning the platform to a
// spawnSync branch makes the probe fail loudly on every host instead.
const POISON_PROBE = [
  'import { createRequire } from "node:module";',
  "const require = createRequire(import.meta.url);",
  'const cp = require("node:child_process");',
  'cp.spawnSync = () => { throw new Error("EAGER_PROBE_FIRED"); };',
  'Object.defineProperty(process, "platform", { value: "darwin", configurable: true });',
  'if (process.platform !== "darwin") { console.error("PLATFORM_OVERRIDE_FAILED"); process.exit(3); }',
].join("\n");

const platformOverridable = (() => {
  try {
    Object.defineProperty(process, "platform", { value: process.platform, configurable: true });
    return true;
  } catch {
    return false;
  }
})();

/** Run `body` in a child process where the incarnation probe throws if it runs. */
function runWithPoisonedProbe(body: string): { status: number | null; output: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-lazy-probe-"));
  try {
    const child = path.join(dir, "probe.mts");
    fs.writeFileSync(child, `${POISON_PROBE}\n${body}\n`);
    const result = spawnSync(process.execPath, ["--import", "tsx", child], { encoding: "utf-8" });
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Regression guard for issue #245: the process-incarnation probe ran at module
 * scope, so every pi launch paid a spawnSync (powershell.exe on Windows) before
 * any hermes code ran, whether or not a lock was ever taken.
 */
describe(
  "process-incarnation probing is deferred past extension load",
  { skip: platformOverridable ? false : "process.platform cannot be overridden on this runtime" },
  () => {
    it("imports the module graph without probing the process incarnation", () => {
      const { status, output } = runWithPoisonedProbe(
        [`await import(${JSON.stringify(modulePath)});`, 'console.log("IMPORTED_OK");'].join("\n"),
      );

      assert.equal(status, 0, output);
      assert.match(output, /IMPORTED_OK/);
    });

    it("still probes once a coordinator is constructed", () => {
      const { status, output } = runWithPoisonedProbe(
        [
          `const { AtomicLockCoordinator } = await import(${JSON.stringify(modulePath)});`,
          'new AtomicLockCoordinator("unused.sqlite");',
        ].join("\n"),
      );

      assert.notEqual(status, 0, output);
      assert.match(output, /EAGER_PROBE_FIRED/);
    });
  },
);
