import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryConfig, ThinkingLevel } from "../types.js";
import { AGENT_ROOT } from "../paths.js";

type ChildLlmConfig = Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride" | "childExtensionPaths">;

interface PiExecResult {
  code: number;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
}

interface ExecChildPromptOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  retryWithoutOverrides?: boolean;
}

interface ExecChildPromptDependencies {
  removeTemporaryDirectory: (dir: string) => Promise<void>;
}

const DEFAULT_EXEC_CHILD_PROMPT_DEPENDENCIES: ExecChildPromptDependencies = {
  removeTemporaryDirectory: async (dir) => {
    await fs.rm(dir, { recursive: true, force: true });
  },
};

const WATCHDOG_EXIT_GRACE_MS = 5000;
const CHILD_PROCESS_WATCHDOG_PATH = fileURLToPath(
  new URL("./child-process-watchdog.mjs", import.meta.url),
);
export interface ChildPiInvocation {
  command: string;
  args: string[];
}

interface ResolveChildPiInvocationOptions {
  platform?: NodeJS.Platform;
  execPath?: string;
  argv?: string[];
  piCliPath?: string | null;
}

const OVERRIDE_FAILURE_SUBJECT = /\b(model|provider|thinking)\b/i;
const OVERRIDE_FAILURE_REASON = /\b(not found|unknown|invalid|unsupported|unavailable|unrecognized|no match|no matches|cannot resolve|failed to resolve)\b/i;

// Resolve the path to pi-hermes-memory's own extension entry point.
// Used to pass -e <path> to child subprocesses so they only load this
// extension instead of all plugins from settings.json.
const OWN_EXTENSION_PATH: string = (() => {
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), "../index.ts");
  } catch {
    return "";
  }
})();

function normalizedModelOverride(config: ChildLlmConfig): string | undefined {
  const trimmed = config.llmModelOverride?.trim();
  return trimmed ? trimmed : undefined;
}

function effectiveThinkingOverride(config: ChildLlmConfig): ThinkingLevel | undefined {
  return config.llmThinkingOverride ?? (normalizedModelOverride(config) ? "off" : undefined);
}

export function hasChildLlmOverrides(config: ChildLlmConfig): boolean {
  return normalizedModelOverride(config) !== undefined || effectiveThinkingOverride(config) !== undefined;
}

/** @deprecated No longer called after PR #78 — kept for API backward compat. */
export function inheritedExtensionArgs(argv: string[] = process.argv.slice(2)): string[] {
  const args: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    if (current === "-e" || current === "--extension") {
      const next = argv[i + 1];
      if (typeof next === "string" && next.length > 0) {
        args.push(current, next);
        i++;
      }
      continue;
    }

    if (current.startsWith("--extension=")) {
      args.push(current);
    }
  }

  return args;
}

// Provider-auth-adapter packages (e.g. Anthropic/xAI/Codex OAuth) inject
// subscription billing headers via pi.registerProvider(). --no-extensions
// strips these from child `pi -p` subprocesses, which silently rebills
// subscription usage as pay-as-you-go "extra usage" instead (see issue #94).
//
// pi has no runtime API to enumerate loaded extensions or map a registered
// provider back to its extension file, so we can't ask pi "what adapter is
// active" directly. Instead we mirror pi's OWN static package-discovery
// convention (package.json -> "pi": { "extensions": [...] }, the same field
// pi-hermes-memory's own package.json declares) and match sibling package
// names against a naming convention, so a future xai-oauth-adapter or
// pi-codex-oauth-adapter is picked up automatically without a code change
// here — no code execution, just JSON reads of sibling package.json files.
const AUTH_ADAPTER_NAME_PATTERNS: readonly RegExp[] = [
  /(^|[-/])oauth-adapter$/,
  /(^|[-/])auth-adapter$/,
];

function isAuthAdapterPackageName(name: string): boolean {
  return AUTH_ADAPTER_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

// Read a sibling package's "pi": { "extensions": [...] } manifest field —
// the same field pi's own loader reads — and resolve declared paths
// relative to that package's directory. Mirrors loader.js#resolveExtensionEntries.
function readPackageExtensionEntries(packageDir: string): string[] {
  const packageJsonPath = join(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) return [];

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  } catch {
    return [];
  }

  const declaredExtensions = (manifest as { pi?: { extensions?: unknown } } | null)?.pi?.extensions;
  if (!Array.isArray(declaredExtensions)) return [];

  const entries: string[] = [];
  for (const relativePath of declaredExtensions) {
    if (typeof relativePath !== "string") continue;
    const resolved = resolve(packageDir, relativePath);
    if (existsSync(resolved)) entries.push(resolved);
  }
  return entries;
}

function scanRootForAuthAdapters(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  const detected: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith("@")) {
      // Scoped org, e.g. @xai/pi-oauth-adapter — one extra level, no deeper.
      const scopeDir = join(root, entry);
      let scopedPackages: string[];
      try {
        scopedPackages = readdirSync(scopeDir);
      } catch {
        continue;
      }
      for (const scopedName of scopedPackages) {
        if (!isAuthAdapterPackageName(scopedName)) continue;
        detected.push(...readPackageExtensionEntries(join(scopeDir, scopedName)));
      }
      continue;
    }

    if (!isAuthAdapterPackageName(entry)) continue;
    detected.push(...readPackageExtensionEntries(join(root, entry)));
  }
  return detected;
}

// `roots` is overridable so tests can point this at fixture directories
// instead of the real sibling-packages trees. Two roots are scanned by
// default: packages installed alongside pi-hermes-memory's own package
// (the common npm-managed-extensions layout), and AGENT_ROOT's npm
// directory (covers pi-hermes-memory being loaded from elsewhere, e.g. a
// local dev checkout via -e, while the adapter is still npm-managed).
export function detectAuthAdapterExtensionPaths(roots?: string[]): string[] {
  const searchRoots = roots ?? [
    OWN_EXTENSION_PATH ? resolve(dirname(dirname(OWN_EXTENSION_PATH)), "..") : "",
    join(AGENT_ROOT, "npm", "node_modules"),
  ].filter((root) => root.length > 0);

  const seenRoots: string[] = [];
  const detected: string[] = [];
  for (const root of searchRoots) {
    if (seenRoots.includes(root)) continue;
    seenRoots.push(root);
    detected.push(...scanRootForAuthAdapters(root));
  }
  return detected;
}

function childExtensionPaths(config: ChildLlmConfig): string[] {
  const candidates = [
    OWN_EXTENSION_PATH,
    ...(config.childExtensionPaths ?? []),
    ...detectAuthAdapterExtensionPaths(),
  ];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    const normalized = resolve(trimmed);
    if (seen.has(normalized) || !existsSync(normalized)) continue;
    seen.add(normalized);
    paths.push(normalized);
  }
  return paths;
}

function appendOwnExtensionArgs(args: string[], config: ChildLlmConfig): void {
  // Skip all packages from settings.json (--no-extensions) — the subprocess
  // loads only Hermes and explicitly required provider adapters.
  args.push("--no-extensions");
  for (const extensionPath of childExtensionPaths(config)) {
    args.push("-e", extensionPath);
  }
}

export function buildChildPiPromptArgs(
  prompt: string,
  config: ChildLlmConfig,
  _argv: string[] = process.argv.slice(2),
): string[] {
  const args = ["-p", "--no-session"];
  const model = normalizedModelOverride(config);
  const thinking = effectiveThinkingOverride(config);

  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  appendOwnExtensionArgs(args, config);
  args.push(prompt);

  return args;
}

function basePromptArgs(prompt: string, config: ChildLlmConfig): string[] {
  // Always use --no-extensions + own path so the retry also avoids loading
  // all settings.json packages — matching the primary code path.
  const args = ["-p", "--no-session"];
  appendOwnExtensionArgs(args, config);
  args.push(prompt);
  return args;
}

function isCliJsPath(value: string | undefined): value is string {
  if (!value) return false;
  return value.replace(/\\/g, "/").toLowerCase().endsWith("/cli.js");
}

function resolvedInstalledPiCliPath(): string | undefined {
  try {
    const packageEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
    const entryPath = fileURLToPath(packageEntry);
    const cliPath = join(dirname(entryPath), "cli.js");
    return existsSync(cliPath) ? cliPath : undefined;
  } catch {
    return undefined;
  }
}

function resolvedPiCliPath(options: ResolveChildPiInvocationOptions): string | undefined {
  if (options.piCliPath !== undefined) {
    return options.piCliPath ?? undefined;
  }

  const argv = options.argv ?? process.argv;
  const currentCli = argv[1];
  if (isCliJsPath(currentCli) && existsSync(currentCli)) {
    return currentCli;
  }

  return resolvedInstalledPiCliPath();
}

export function resolveChildPiInvocation(
  args: string[],
  options: ResolveChildPiInvocationOptions = {},
): ChildPiInvocation {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command: "pi", args };
  }

  const piCliPath = resolvedPiCliPath(options);
  if (!piCliPath) {
    return { command: "pi", args };
  }

  return {
    command: options.execPath ?? process.execPath,
    args: [piCliPath, ...args],
  };
}

export function resolveWatchedChildPiInvocation(
  invocation: ChildPiInvocation,
  timeoutMs: number,
): ChildPiInvocation {
  return {
    command: process.execPath,
    args: [
      CHILD_PROCESS_WATCHDOG_PATH,
      String(timeoutMs),
      invocation.command,
      ...invocation.args,
    ],
  };
}

function shouldRetryWithoutOverridesFromText(text: string | undefined): boolean {
  if (!text) return false;
  return OVERRIDE_FAILURE_SUBJECT.test(text) && OVERRIDE_FAILURE_REASON.test(text);
}

function shouldRetryWithoutOverrides(result: PiExecResult): boolean {
  return shouldRetryWithoutOverridesFromText(result.stderr) || shouldRetryWithoutOverridesFromText(result.stdout);
}

function shouldRetryWithoutOverridesForError(error: unknown): boolean {
  return shouldRetryWithoutOverridesFromText(String(error));
}

async function writePromptToTemporaryFile(prompt: string): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.mkdtemp(join(os.tmpdir(), "pi-hermes-prompt-"));
  const filePath = join(dir, "prompt.md");
  try {
    await fs.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
    return { dir, filePath };
  } catch (error) {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

export async function execChildPrompt(
  pi: Pick<ExtensionAPI, "exec">,
  prompt: string,
  config: ChildLlmConfig,
  options: ExecChildPromptOptions,
  dependencies: ExecChildPromptDependencies = DEFAULT_EXEC_CHILD_PROMPT_DEPENDENCIES,
): Promise<PiExecResult> {
  const execOptions = {
    signal: options.signal,
    timeout: options.timeoutMs + WATCHDOG_EXIT_GRACE_MS,
  };
  const temporaryPrompt = await writePromptToTemporaryFile(prompt);
  const promptReference = `@${temporaryPrompt.filePath}`;

  try {
    try {
      const invocation = resolveWatchedChildPiInvocation(
        resolveChildPiInvocation(buildChildPiPromptArgs(promptReference, config)),
        options.timeoutMs,
      );
      const result = await pi.exec(invocation.command, invocation.args, execOptions) as PiExecResult;
      if (
        result.code === 0 ||
        !options.retryWithoutOverrides ||
        !hasChildLlmOverrides(config) ||
        !shouldRetryWithoutOverrides(result)
      ) {
        return result;
      }
    } catch (error) {
      if (
        !options.retryWithoutOverrides ||
        !hasChildLlmOverrides(config) ||
        !shouldRetryWithoutOverridesForError(error)
      ) {
        throw error;
      }
    }

    const retryInvocation = resolveWatchedChildPiInvocation(
      resolveChildPiInvocation(basePromptArgs(promptReference, config)),
      options.timeoutMs,
    );
    return await pi.exec(retryInvocation.command, retryInvocation.args, execOptions) as PiExecResult;
  } finally {
    try { await dependencies.removeTemporaryDirectory(temporaryPrompt.dir); } catch {}
  }
}
