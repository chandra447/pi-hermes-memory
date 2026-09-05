/**
 * Parse and apply structured memory operations from direct background review.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple, type Message, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import type { DatabaseManager } from "../store/db.js";
import type { MemoryCategory, MemoryConfig, MemoryResult, ThinkingLevel } from "../types.js";

export interface ReviewMemoryOperation {
  action: "add" | "replace" | "remove";
  target: "memory" | "user" | "project" | "failure";
  content?: string;
  old_text?: string;
  category?: MemoryCategory;
  failure_reason?: string;
}

export interface ApplyReviewOperationsResult {
  appliedCount: number;
  skippedCount: number;
  error?: string;
  aborted?: boolean;
}

export interface DirectReviewResult {
  ok: boolean;
  appliedCount: number;
  fallbackReason?: "no_model" | "no_auth" | "aborted" | "parse_error" | "provider_error" | "empty";
  error?: string;
}

export interface RunDirectMemoryCompletionOptions {
  userPrompt: string;
  systemPrompt: string;
  config: Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride">;
  timeoutMs?: number;
  signal?: AbortSignal;
  requireAtomicShrink?: boolean;
  expectedTarget?: ReviewMemoryOperation["target"];
}

/** Shared transport gate: review/flush/consolidation/correction all default to
 * the in-process direct completion path and fall back to a `pi -p` subprocess
 * only on failure, unless the user forces `reviewTransport: "subprocess"`. */
export function usesDirectTransport(config: Pick<MemoryConfig, "reviewTransport">): boolean {
  return (config.reviewTransport ?? "direct") === "direct";
}

type ReviewLlmConfig = Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride">;

function findExactModelReferenceMatch(modelReference: string, availableModels: Model<Api>[]): Model<Api> | undefined {
  const trimmedReference = modelReference.trim();
  if (!trimmedReference) return undefined;

  const normalizedReference = trimmedReference.toLowerCase();
  const canonicalMatches = availableModels.filter(
    (model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
  );
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  if (canonicalMatches.length > 1) return undefined;

  const slashIndex = trimmedReference.indexOf("/");
  if (slashIndex !== -1) {
    const provider = trimmedReference.substring(0, slashIndex).trim();
    const modelId = trimmedReference.substring(slashIndex + 1).trim();
    if (provider && modelId) {
      const providerMatches = availableModels.filter(
        (model) => model.provider.toLowerCase() === provider.toLowerCase()
          && model.id.toLowerCase() === modelId.toLowerCase(),
      );
      if (providerMatches.length === 1) return providerMatches[0];
    }
  }

  const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

function normalizedModelOverride(config: ReviewLlmConfig): string | undefined {
  const trimmed = config.llmModelOverride?.trim();
  return trimmed ? trimmed : undefined;
}

function effectiveThinkingOverride(config: ReviewLlmConfig): ThinkingLevel | undefined {
  return config.llmThinkingOverride ?? (normalizedModelOverride(config) ? "off" : undefined);
}

type ReviewModelRegistry = ExtensionContext["modelRegistry"];

/** Derived from the installed SDK so headers/baseUrl track ProviderHeaders instead of a local mirror. */
export type ResolvedRequestAuth = Awaited<ReturnType<ReviewModelRegistry["getApiKeyAndHeaders"]>>;

type DirectReviewAuth = Omit<Extract<ResolvedRequestAuth, { ok: true }>, "ok">;

export function buildDirectReviewCompletionOptions(
  model: Model<Api>,
  auth: DirectReviewAuth,
  thinking: ThinkingLevel | undefined,
  signal: AbortSignal,
): SimpleStreamOptions {
  const options: SimpleStreamOptions = {
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
    signal,
  };
  if (model.reasoning && thinking && thinking !== "off") {
    options.reasoning = thinking;
  }
  return options;
}

export function resolveReviewModel(
  ctxModel: Model<Api> | undefined,
  modelRegistry: ReviewModelRegistry,
  config: ReviewLlmConfig,
): Model<Api> | undefined {
  const override = normalizedModelOverride(config);
  if (override) {
    const matched = findExactModelReferenceMatch(override, modelRegistry.getAll());
    if (matched) return matched;
  }
  return ctxModel;
}

/**
 * Provider responses that mean "this key is no longer good", as opposed to a
 * transport hiccup or a model error worth falling back to a subprocess for.
 */
const AUTH_REJECTION_PATTERN = new RegExp([
  String.raw`\b(401|403)\b`,
  "unauthorized",
  "forbidden",
  String.raw`invalid[\s_-]*api[\s_-]*key`,
  String.raw`authentication[\s_-]*(failed|error)`,
  String.raw`(invalid|expired|revoked)[\s_-]*(access[\s_-]*)?(token|key|credential)`,
  String.raw`(token|key|credential)[\s_-]*(is[\s_-]*|has[\s_-]*been[\s_-]*)?(invalid|expired|revoked)`,
].join("|"), "i");

export function isAuthRejection(message: string): boolean {
  return AUTH_REJECTION_PATTERN.test(message);
}

const CREDENTIAL_HEADER_NAMES = new Set(["authorization", "x-api-key", "cf-aig-authorization"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasRequestAuth(auth: DirectReviewAuth): boolean {
  if (isNonEmptyString(auth.apiKey)) return true;
  return Object.entries(auth.headers ?? {}).some(
    ([key, value]) => CREDENTIAL_HEADER_NAMES.has(key.toLowerCase()) && isNonEmptyString(value),
  );
}

function sameStringRecord(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {});
  const rightKeys = Object.keys(right ?? {});
  return leftEntries.length === rightKeys.length
    && leftEntries.every(([key, value]) => right?.[key] === value);
}

function headerPairs(headers: DirectReviewAuth["headers"]): Array<[string, string | null]> {
  return Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]);
}

function sameHeaders(
  left: DirectReviewAuth["headers"],
  right: DirectReviewAuth["headers"],
): boolean {
  const remaining = headerPairs(right);
  const leftPairs = headerPairs(left);
  if (leftPairs.length !== remaining.length) return false;
  for (const [key, value] of leftPairs) {
    const index = remaining.findIndex((pair) => pair[0] === key && pair[1] === value);
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return true;
}

function sameRequestAuth(left: DirectReviewAuth, right: DirectReviewAuth): boolean {
  return left.apiKey === right.apiKey
    && sameHeaders(left.headers, right.headers)
    && sameStringRecord(left.env, right.env);
}

/**
 * Resolve request auth through the public ModelRegistry API. Resolve it again
 * after an auth rejection so Pi can supply refreshed credentials when its
 * registry supports that, without reaching into version-sensitive internals.
 */
export async function resolveRequestAuth(
  modelRegistry: ReviewModelRegistry,
  model: Model<Api>,
): Promise<ResolvedRequestAuth> {
  return modelRegistry.getApiKeyAndHeaders(model);
}

function extractJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // continue
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  return null;
}

function isMemoryCategory(value: unknown): value is MemoryCategory {
  return value === "failure"
    || value === "correction"
    || value === "insight"
    || value === "preference"
    || value === "convention"
    || value === "tool-quirk";
}

function isReviewTarget(value: unknown): value is ReviewMemoryOperation["target"] {
  return value === "memory" || value === "user" || value === "project" || value === "failure";
}

function isReviewAction(value: unknown): value is ReviewMemoryOperation["action"] {
  return value === "add" || value === "replace" || value === "remove";
}

export function parseReviewOperations(text: string): ReviewMemoryOperation[] | null {
  if (/nothing to save/i.test(text) && !text.includes("{")) {
    return [];
  }

  const payload = extractJsonPayload(text);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const operations = (payload as { operations?: unknown }).operations;
  if (!Array.isArray(operations)) return null;

  const parsed: ReviewMemoryOperation[] = [];
  for (const item of operations) {
    if (!item || typeof item !== "object") continue;
    const op = item as Record<string, unknown>;
    if (!isReviewAction(op.action) || !isReviewTarget(op.target)) continue;

    const operation: ReviewMemoryOperation = {
      action: op.action,
      target: op.target,
    };
    if (typeof op.content === "string") operation.content = op.content;
    if (typeof op.old_text === "string") operation.old_text = op.old_text;
    if (isMemoryCategory(op.category)) operation.category = op.category;
    if (typeof op.failure_reason === "string") operation.failure_reason = op.failure_reason;
    parsed.push(operation);
  }

  return parsed;
}

export async function applyReviewOperations(
  store: MemoryStore,
  projectStore: MemoryStore | null,
  operations: ReviewMemoryOperation[],
  _dbManager: DatabaseManager | null = null,
  projectName?: string | null,
  options: {
    requireAtomicShrink?: boolean;
    expectedTarget?: ReviewMemoryOperation["target"];
    signal?: AbortSignal;
  } = {},
): Promise<ApplyReviewOperationsResult> {
  if (options.requireAtomicShrink) {
    if (operations.length === 0) {
      return {
        appliedCount: 0,
        skippedCount: 0,
        error: "Atomic plan requires at least one operation.",
      };
    }

    const target = operations[0]?.target;
    if (!target || operations.some((operation) => operation.target !== target)) {
      return {
        appliedCount: 0,
        skippedCount: operations.length,
        error: "Atomic plan must use exactly one target.",
      };
    }
    if (options.expectedTarget && target !== options.expectedTarget) {
      return {
        appliedCount: 0,
        skippedCount: operations.length,
        error: `Atomic plan targeted '${target}', expected '${options.expectedTarget}'.`,
      };
    }
    if (target === "project" && !projectStore) {
      return {
        appliedCount: 0,
        skippedCount: operations.length,
        error: "Project memory is unavailable.",
      };
    }

    if (options.signal?.aborted) {
      return { appliedCount: 0, skippedCount: operations.length, aborted: true };
    }
    const activeStore = target === "project" ? projectStore! : store;
    const memoryTarget = target === "project" ? "memory" : target;
    const mutationOperations = operations.map((operation) => ({
      action: operation.action,
      content: operation.content,
      oldText: operation.old_text,
      category: target === "failure" ? operation.category ?? "failure" : operation.category,
      failureReason: operation.failure_reason,
      project: target === "failure" ? projectName ?? undefined : undefined,
    }));
    const result = await activeStore.applyMutationPlan(memoryTarget, mutationOperations, {
      requireShrink: true,
      signal: options.signal,
    });
    if (options.signal?.aborted && !result.success) {
      return { appliedCount: 0, skippedCount: operations.length, aborted: true };
    }
    return result.success
      ? { appliedCount: operations.length, skippedCount: 0 }
      : {
          appliedCount: 0,
          skippedCount: operations.length,
          error: result.error ?? "Atomic memory plan failed.",
        };
  }

  let appliedCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < operations.length; i++) {
    if (options.signal?.aborted) {
      skippedCount += operations.length - i;
      return { appliedCount, skippedCount, aborted: appliedCount === 0 };
    }
    const op = operations[i];
    if (op.target === "project" && !projectStore) {
      skippedCount++;
      continue;
    }

    const rawTarget = op.target;
    const memoryTarget = rawTarget === "project" ? "memory" : rawTarget === "failure" ? "failure" : rawTarget;
    const activeStore = rawTarget === "project" ? projectStore! : store;

    let result: MemoryResult;
    switch (op.action) {
      case "add": {
        if (!op.content?.trim()) {
          skippedCount++;
          continue;
        }
        if (rawTarget === "failure") {
          const category = op.category ?? "failure";
          result = await activeStore.addFailure(op.content, {
            category,
            failureReason: op.failure_reason,
            project: projectName ?? undefined,
            signal: options.signal,
          });
          if (result.success) {
            appliedCount++;
          } else {
            skippedCount++;
          }
        } else {
          result = await activeStore.add(memoryTarget, op.content, options.signal);
          if (result.success) {
            appliedCount++;
          } else {
            skippedCount++;
          }
        }
        break;
      }
      case "replace": {
        if (!op.old_text || !op.content?.trim()) {
          skippedCount++;
          continue;
        }
        result = await activeStore.replace(memoryTarget, op.old_text, op.content, options.signal);
        if (result.success) {
          appliedCount++;
        } else {
          skippedCount++;
        }
        break;
      }
      case "remove": {
        if (!op.old_text) {
          skippedCount++;
          continue;
        }
        result = await activeStore.remove(memoryTarget, op.old_text, options.signal);
        if (result.success) {
          appliedCount++;
        } else {
          skippedCount++;
        }
        break;
      }
      default:
        skippedCount++;
        continue;
    }

    if (options.signal?.aborted) {
      skippedCount += operations.length - i - 1;
      return { appliedCount, skippedCount, aborted: appliedCount === 0 };
    }
  }

  return { appliedCount, skippedCount };
}

function responseText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => (
      !!block && typeof block === "object" && (block as { type?: string }).type === "text"
    ))
    .map((block) => block.text)
    .join("\n");
}

export async function runDirectMemoryCompletion(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  options: RunDirectMemoryCompletionOptions,
  dbManager: DatabaseManager | null = null,
  projectName?: string | null,
  deps: { completeSimple?: typeof completeSimple } = {},
): Promise<DirectReviewResult> {
  const complete = deps.completeSimple ?? completeSimple;
  const aborted = (): DirectReviewResult => ({ ok: false, appliedCount: 0, fallbackReason: "aborted" });
  if (options.signal?.aborted) return aborted();

  const model = resolveReviewModel(ctx.model, ctx.modelRegistry, options.config);
  if (!model) {
    return { ok: false, appliedCount: 0, fallbackReason: "no_model" };
  }

  const auth = await resolveRequestAuth(ctx.modelRegistry, model);
  if (options.signal?.aborted) return aborted();
  if (!auth.ok || !hasRequestAuth(auth)) {
    return {
      ok: false,
      appliedCount: 0,
      fallbackReason: "no_auth",
      error: auth.ok ? `No request authentication for ${model.provider}` : auth.error,
    };
  }
  let requestAuth: DirectReviewAuth = { apiKey: auth.apiKey, headers: auth.headers, env: auth.env };

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 120000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (options.signal) {
    options.signal.addEventListener("abort", onExternalAbort, { once: true });
    if (options.signal.aborted) controller.abort();
  }

  const thinking = effectiveThinkingOverride(options.config);
  const userMessage: Message = {
    role: "user",
    content: [{ type: "text", text: options.userPrompt }],
    timestamp: Date.now(),
  };

  const request = { systemPrompt: options.systemPrompt, messages: [userMessage] };

  const completeOnce = async () => {
    const response = await complete(
      model,
      request,
      buildDirectReviewCompletionOptions(model, requestAuth, thinking, controller.signal),
    );
    if (response.stopReason === "error" && isAuthRejection(response.errorMessage ?? "")) {
      throw new Error(response.errorMessage ?? "error");
    }
    return response;
  };

  try {
    let response;
    try {
      response = await completeOnce();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted || !isAuthRejection(message)) throw err;

      // Thrown failures and error assistant responses share this path. API keys
      // and OAuth headers can both rotate, so re-resolve through Pi and retry
      // once only when the effective request auth actually changed; otherwise
      // this is a real auth problem and the subprocess fallback should handle
      // it (#139).
      const rotated = await resolveRequestAuth(ctx.modelRegistry, model);
      if (!rotated.ok || !hasRequestAuth(rotated) || sameRequestAuth(rotated, requestAuth)) throw err;

      requestAuth = { apiKey: rotated.apiKey, headers: rotated.headers, env: rotated.env };
      response = await completeOnce();
    }

    if (response.stopReason === "aborted" || controller.signal.aborted || options.signal?.aborted) {
      return aborted();
    }

    const text = responseText(response.content);
    const operations = parseReviewOperations(text);
    if (operations === null) {
      return { ok: false, appliedCount: 0, fallbackReason: "parse_error" };
    }
    if (operations.length === 0) {
      return { ok: true, appliedCount: 0, fallbackReason: "empty" };
    }
    if (controller.signal.aborted || options.signal?.aborted) {
      return aborted();
    }

    const applied = await applyReviewOperations(
      store,
      projectStore,
      operations,
      dbManager,
      projectName,
      {
        requireAtomicShrink: options.requireAtomicShrink,
        expectedTarget: options.expectedTarget,
        signal: options.signal,
      },
    );
    if (applied.aborted && applied.appliedCount === 0) {
      return aborted();
    }
    if (applied.error) {
      return {
        ok: false,
        appliedCount: 0,
        fallbackReason: "provider_error",
        error: applied.error,
      };
    }
    return { ok: true, appliedCount: applied.appliedCount };
  } catch (err) {
    if (controller.signal.aborted || options.signal?.aborted) {
      return aborted();
    }
    return {
      ok: false,
      appliedCount: 0,
      fallbackReason: "provider_error",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}
