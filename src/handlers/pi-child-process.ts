import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryConfig, ThinkingLevel } from "../types.js";

type ChildLlmConfig = Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride">;

interface PiExecResult {
  code: number;
  stdout?: string;
  stderr?: string;
}

interface ExecChildPromptOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  retryWithoutOverrides?: boolean;
}

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

function appendOwnExtensionArgs(args: string[]): void {
  // Skip all packages from settings.json (--no-extensions) — the subprocess
  // only needs pi-hermes-memory to access the memory tool. Loading every
  // plugin (context-mode, pi-lens, pi-web-access, pi-review, …) wastes
  // prompt tokens and startup CPU for simple one-shot memory tasks.
  if (OWN_EXTENSION_PATH) {
    args.push("--no-extensions", "-e", OWN_EXTENSION_PATH);
  }
}

export function buildChildPiPromptArgs(prompt: string, config: ChildLlmConfig, _argv?: string[]): string[] {
  const args = ["-p", "--no-session"];
  const model = normalizedModelOverride(config);
  const thinking = effectiveThinkingOverride(config);

  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  appendOwnExtensionArgs(args);
  args.push(prompt);

  return args;
}

function basePromptArgs(prompt: string): string[] {
  // Always use --no-extensions + own path so the retry also avoids loading
  // all settings.json packages — matching the primary code path.
  const args = ["-p", "--no-session"];
  appendOwnExtensionArgs(args);
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

export async function execChildPrompt(
  pi: Pick<ExtensionAPI, "exec">,
  prompt: string,
  config: ChildLlmConfig,
  options: ExecChildPromptOptions,
): Promise<PiExecResult> {
  const execOptions = {
    signal: options.signal,
    timeout: options.timeoutMs,
  };

  try {
    const invocation = resolveChildPiInvocation(buildChildPiPromptArgs(prompt, config));
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

  const retryInvocation = resolveChildPiInvocation(basePromptArgs(prompt));
  return pi.exec(retryInvocation.command, retryInvocation.args, execOptions) as Promise<PiExecResult>;
}
