/**
 * Integration test — spawn a real pi-agent CLI against THIS fork.
 *
 * This is a reproduction guard for the Mneme startup crash. With Mneme
 * enabled, loading the extension in a headless `pi --print` run hard-crashes
 * the Bun runtime (NAPI FATAL ERROR / SIGILL, exit 132) during extension
 * init, before any provider call. The crash is deterministic: the fork with
 * Mneme disabled runs the exact same spawn cleanly.
 *
 * The test is hermetic and self-contained:
 *  - `PI_CODING_AGENT_DIR` is pointed at a throwaway temp dir. Both pi and
 *    this fork honor that env var (see src/paths.ts resolveAgentRoot), so the
 *    run never touches the real ~/.pi/agent.
 *  - The extension is loaded directly from this repo via `-e <repo>/src/index.ts`,
 *    so the FORK's code is exercised — not the published npm copy that
 *    `npm:pi-hermes-memory` resolves to (which has no Mneme).
 *  - No network/provider is required: the crash happens during extension init,
 *    before the provider is contacted. `--offline` keeps startup network-free.
 *
 * IMPORTANT — it targets the COMPILED pi binary (Bun standalone, an ELF
 * executable), NOT the JS CLI. The crash is Bun/compiled-binary specific:
 * the same Mneme-enabled config runs cleanly under the node-based JS CLI
 * (`@earendil-works/pi-coding-agent/dist/cli.js`), which a naive `which pi`
 * inside this repo resolves to (via node_modules/.bin). findPi() therefore
 * rejects node-script CLIs and returns null if only those exist, so the test
 * skips rather than passing vacuously against the wrong runtime.
 *
 * Two cases share one spawn helper:
 *  - Mneme disabled  -> must NOT hard-crash (proves the harness has no false
 *                       positives; green in all states).
 *  - Mneme enabled   -> must NOT hard-crash (the regression gate; red while the
 *                       Mneme init crash exists, green once it is fixed).
 *
 * The whole test skips (does not fail) when the pi binary cannot be located,
 * so `npm test` stays green on machines without pi.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const EXTENSION = path.join(REPO_ROOT, "src", "index.ts");

/** True if the file is an ELF executable (the compiled pi standalone). */
function isElf(p: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    return buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* noop */ }
  }
}

/**
 * Locate the COMPILED pi binary. PI_BINARY override wins; otherwise we
 * consider `which pi` and the mise install tree, and return the first that is
 * an ELF executable. Node-script CLIs (e.g. the fork's node_modules/.bin/pi,
 * which points at @earendil-works/pi-coding-agent/dist/cli.js) are rejected —
 * the crash under test is Bun/compiled-binary specific, so testing against the
 * JS CLI would pass vacuously.
 */
function findPi(): string | null {
  const candidates: string[] = [];
  const fromEnv = process.env.PI_BINARY?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) candidates.unshift(fromEnv);

  const which = spawnSync("which", ["pi"], { encoding: "utf8" });
  if (which.status === 0) {
    for (const p of which.stdout.trim().split("\n")) if (p) candidates.push(p);
  }

  const installsDir = path.join(os.homedir(), ".local", "share", "mise", "installs", "pi");
  if (fs.existsSync(installsDir)) {
    for (const v of fs.readdirSync(installsDir)) {
      if (/^\d/.test(v)) candidates.push(path.join(installsDir, v, "pi", "pi"));
    }
    candidates.push(path.join(installsDir, "latest", "pi", "pi"));
  }

  const seen = new Set<string>();
  for (const c of candidates) {
    let resolved: string;
    try {
      resolved = fs.realpathSync(c);
    } catch {
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (isElf(resolved)) return resolved;
  }
  return null;
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

/** Spawn pi headless with the fork extension + a temp agent dir; resolve on exit. */
function runPi(pi: string, agentDir: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(
      pi,
      [
        "-e",
        EXTENSION,
        "--provider",
        "openai",
        "--model",
        "gpt-4o-mini",
        "--offline",
        "--print",
        "Say OK",
      ],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));

    // Hard cap: a crash or a stuck provider must not hang the suite.
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }, 90_000);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, output: `spawn error: ${err.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output: out });
    });
  });
}

/** A "hard crash" = killed by a fatal signal, or a Bun/NAPI panic marker. */
function isHardCrash(r: RunResult): { crashed: boolean; why: string } {
  const panic = /Bun has crashed|NAPI FATAL ERROR|oh no:|Invalid machine code|Ungültiger Maschinenbefehl/i.test(
    r.output,
  );
  const fatalSignal = r.code === null && r.signal !== null;
  const fatalCode = r.code !== null && r.code >= 128;
  if (panic || fatalSignal || fatalCode) {
    return {
      crashed: true,
      why:
        `code=${r.code ?? "null"} signal=${r.signal ?? "none"} ` +
        `${panic ? "(Bun/NAPI panic marker)" : ""} ` +
        `${fatalSignal ? "(killed by signal)" : ""} ${fatalCode ? "(fatal exit code)" : ""}`,
    };
  }
  return { crashed: false, why: "" };
}

let pi: string | null;
let tmpDirs: string[] = [];

function makeAgentDir(mnemeConfig: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cli-mneme-"));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, "hermes-memory-config.json"), mnemeConfig);
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o-mini" }),
  );
  return dir;
}

function tail(s: string, n = 12): string {
  const lines = s.trimEnd().split("\n").filter(Boolean);
  return lines.slice(-n).join("\n");
}

describe("integration: pi-cli Mneme startup (spawns real pi)", () => {
  before(() => {
    pi = findPi();
  });

  after(() => {
    for (const d of tmpDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it("skips when the compiled pi binary is not available", () => {
    if (!pi) {
      // node:test has no per-test skip here; the two cases below no-op, so this
      // only surfaces a friendly note. Set PI_BINARY to a compiled pi to force it.
      console.log(
        "  (skipped: no compiled pi binary found on PATH/mise; set PI_BINARY to override)",
      );
    }
  });

  it("does not hard-crash when Mneme is disabled (harness sanity)", async () => {
    if (!pi) return;
    const dir = makeAgentDir(JSON.stringify({ mneme: { enabled: false } }));
    const r = await runPi(pi, dir);
    const { crashed, why } = isHardCrash(r);
    assert.ok(
      !crashed,
      `Mneme-DISABLED run should be clean, but it hard-crashed: ${why}\n--- output tail ---\n${tail(r.output)}`,
    );
  });

  it("does not hard-crash when Mneme is enabled (regression gate)", async () => {
    if (!pi) return;
    const dir = makeAgentDir(JSON.stringify({ mneme: { enabled: true } }));
    const r = await runPi(pi, dir);
    const { crashed, why } = isHardCrash(r);
    assert.ok(
      !crashed,
      `Mneme-ENABLED run hard-crashed pi (the bug being fixed): ${why}\n--- output tail ---\n${tail(r.output)}`,
    );
  });
});
