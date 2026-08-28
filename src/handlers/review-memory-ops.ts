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
}

export interface DirectReviewResult {
  ok: boolean;
  appliedCount: number;
  fallbackReason?: "no_model" | "no_auth" | "aborted" | "parse_error" | "provider_error" | "empty";
  error?: string;
}

export interface DirectReviewContext {
  /** The exact system prompt used by the active parent turn. */
  systemPrompt: string;
  /** The active parent messages, already converted to LLM messages. */
  messages: Message[];
  /** The active parent thinking level, including "off". */
  thinkingLevel?: ThinkingLevel;
}

export interface RunDirectMemoryCompletionOptions {
  userPrompt: string;
  systemPrompt: string;
  /** Optional parent context. The review instruction is appended after it. */
  context?: DirectReviewContext;
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

function effectiveThinkingOverride(
  config: ReviewLlmConfig,
  context?: DirectReviewContext,
): ThinkingLevel | undefined {
  return config.llmThinkingOverride ?? context?.thinkingLevel;
}

type ReviewModelRegistry = ExtensionContext["modelRegistry"];

export function buildDirectReviewCompletionOptions(
  model: Model<Api>,
  auth: {
    apiKey: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  },
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

/**
 * Mirrors the SDK's ResolvedRequestAuth. pi-coding-agent declares it in
 * core/model-registry but does not re-export it from the package root, and its
 * `exports` map blocks deep imports — so name it here. tsc still checks the
 * shape against the real registry at the call below, so drift is a build error.
 */
export type ResolvedRequestAuth =
  | { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
  | { ok: false; error: string };

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
    const result = await activeStore.applyMutationPlan(memoryTarget, mutationOperations, { requireShrink: true });
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

  for (const op of operations) {
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
          });
          if (result.success) {
            appliedCount++;
          } else {
            skippedCount++;
          }
        } else {
          result = await activeStore.add(memoryTarget, op.content);
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
        result = await activeStore.replace(memoryTarget, op.old_text, op.content);
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
        result = await activeStore.remove(memoryTarget, op.old_text);
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

  }

  return { appliedCount, skippedCount };
}

function responseText(content: unknown): string {
  if (!Array.isArray(content)) return "";

  const text = content
    .filter((block): block is { type: "text"; text: string } => (
      !!block && typeof block === "object" && (block as { type?: string }).type === "text"
    ))
    .map((block) => block.text)
    .join("\n");
  if (text.trim()) return text;

  return content
    .filter((block): block is { type: "thinking"; thinking: string } => (
      !!block && typeof block === "object" && (block as { type?: string }).type === "thinking"
    ))
    .map((block) => block.thinking)
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
  const model = resolveReviewModel(ctx.model, ctx.modelRegistry, options.config);
  if (!model) {
    return { ok: false, appliedCount: 0, fallbackReason: "no_model" };
  }

  const auth = await resolveRequestAuth(ctx.modelRegistry, model);
  if (!auth.ok || !auth.apiKey) {
    return {
      ok: false,
      appliedCount: 0,
      fallbackReason: "no_auth",
      error: auth.ok ? `No API key for ${model.provider}` : auth.error,
    };
  }
  let requestAuth = { apiKey: auth.apiKey, headers: auth.headers, env: auth.env };

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 120000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const thinking = effectiveThinkingOverride(options.config, options.context);
  const userMessage: Message = {
    role: "user",
    content: [{ type: "text", text: options.userPrompt }],
    timestamp: Date.now(),
  };

  const request = {
    systemPrompt: options.context?.systemPrompt ?? options.systemPrompt,
    messages: [...(options.context?.messages ?? []), userMessage],
  };

  try {
    let response;
    try {
      response = await complete(
        model,
        request,
        buildDirectReviewCompletionOptions(model, requestAuth, thinking, controller.signal),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted || !isAuthRejection(message)) throw err;

      // The provider rejected the key mid-flight. A rotation tool may have
      // re-resolve through Pi and retry once only if it returns a different
      // key; otherwise this is a real auth problem and the subprocess
      // fallback should handle it (#139).
      const rotated = await resolveRequestAuth(ctx.modelRegistry, model);
      if (!rotated.ok || !rotated.apiKey || rotated.apiKey === requestAuth.apiKey) throw err;

      requestAuth = { apiKey: rotated.apiKey, headers: rotated.headers, env: rotated.env };
      response = await complete(
        model,
        request,
        buildDirectReviewCompletionOptions(model, requestAuth, thinking, controller.signal),
      );
    }

    if (response.stopReason === "aborted") {
      return { ok: false, appliedCount: 0, fallbackReason: "aborted" };
    }

    const text = responseText(response.content);
    if (!text.trim()) {
      return { ok: true, appliedCount: 0, fallbackReason: "empty" };
    }
    const operations = parseReviewOperations(text);
    if (operations === null) {
      return { ok: false, appliedCount: 0, fallbackReason: "parse_error" };
    }
    if (operations.length === 0) {
      return { ok: true, appliedCount: 0, fallbackReason: "empty" };
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
      },
    );
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
    if (controller.signal.aborted) {
      return { ok: false, appliedCount: 0, fallbackReason: "aborted" };
    }
    return {
      ok: false,
      appliedCount: 0,
      fallbackReason: "provider_error",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}
