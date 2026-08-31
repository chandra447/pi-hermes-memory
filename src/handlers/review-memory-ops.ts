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

type ReviewLlmConfig = Pick<MemoryConfig, "llmModelOverride" | "llmFallbackModels" | "llmThinkingOverride">;

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

function collectFallbackOverrides(config: ReviewLlmConfig): string[] {
  const out: string[] = [];
  for (const raw of config.llmFallbackModels ?? []) {
    const t = raw.trim();
    if (t) out.push(t);
  }
  return out;
}

function allModelOverrides(config: ReviewLlmConfig): string[] {
  const primary = normalizedModelOverride(config);
  const fallbacks = collectFallbackOverrides(config);
  const chain = primary ? [primary, ...fallbacks] : fallbacks;
  return [...new Set(chain)];
}

function effectiveThinkingOverride(config: ReviewLlmConfig): ThinkingLevel | undefined {
  return config.llmThinkingOverride ?? (normalizedModelOverride(config) ? "off" : undefined);
}

type ReviewModelRegistry = ExtensionContext["modelRegistry"];

/** Derived from the installed SDK so headers/baseUrl track ProviderHeaders instead of a local mirror. */
export type ResolvedRequestAuth = Awaited<ReturnType<ReviewModelRegistry["getApiKeyAndHeaders"]>>;

type DirectReviewAuth = Omit<Extract<ResolvedRequestAuth, { ok: true }>, "ok"> & { apiKey: string };

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

export function resolveReviewModels(
  ctxModel: Model<Api> | undefined,
  modelRegistry: ReviewModelRegistry,
  config: ReviewLlmConfig,
): Model<Api>[] {
  const chain = allModelOverrides(config);
  if (chain.length === 0) return ctxModel ? [ctxModel] : [];
  const all = modelRegistry.getAll();
  const resolved: Model<Api>[] = [];
  for (const ref of chain) {
    const m = findExactModelReferenceMatch(ref, all);
    if (m) resolved.push(m);
  }
  // If none of the chain resolved, fall back to active model so we still try something
  if (resolved.length === 0 && ctxModel) resolved.push(ctxModel);
  return resolved;
}

export function getReviewModelChain(config: ReviewLlmConfig): string[] {
  return allModelOverrides(config);
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
  const models = resolveReviewModels(ctx.model, ctx.modelRegistry, options.config);
  if (models.length === 0) {
    return { ok: false, appliedCount: 0, fallbackReason: "no_model" };
  }

  // Try each model in chain: primary + llmFallbackModels. Only retry on
  // provider/auth/transport failures; parse errors are prompt-specific so we
  // still try the next model as it may have better instruction following.
  let lastResult: DirectReviewResult | undefined;
  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi]!;
    const auth = await resolveRequestAuth(ctx.modelRegistry, model);
    if (!auth.ok || !auth.apiKey) {
      lastResult = {
        ok: false,
        appliedCount: 0,
        fallbackReason: "no_auth",
        error: auth.ok ? `No API key for ${model.provider}` : auth.error,
      };
      if (mi < models.length - 1) continue;
      return lastResult;
    }
    let requestAuth: DirectReviewAuth = { apiKey: auth.apiKey, headers: auth.headers, env: auth.env };

  const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 120000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (options.signal) {
      options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    const thinking = effectiveThinkingOverride(options.config);
    const userMessage: Message = {
      role: "user",
      content: [{ type: "text", text: options.userPrompt }],
      timestamp: Date.now(),
    };

    const request = { systemPrompt: options.systemPrompt, messages: [userMessage] };

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
        lastResult = { ok: false, appliedCount: 0, fallbackReason: "aborted" };
        if (mi < models.length - 1) { clearTimeout(timeout); continue; }
        return lastResult;
      }

      const text = responseText(response.content);
      const operations = parseReviewOperations(text);
      if (operations === null) {
        lastResult = { ok: false, appliedCount: 0, fallbackReason: "parse_error" };
        if (mi < models.length - 1) { clearTimeout(timeout); continue; }
        return lastResult;
      }
      if (operations.length === 0) {
        clearTimeout(timeout);
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
        lastResult = {
          ok: false,
          appliedCount: 0,
          fallbackReason: "provider_error",
          error: applied.error,
        };
        if (mi < models.length - 1) { clearTimeout(timeout); continue; }
        return lastResult;
      }
      clearTimeout(timeout);
      return { ok: true, appliedCount: applied.appliedCount };
    } catch (err) {
      if (controller.signal.aborted) {
        lastResult = { ok: false, appliedCount: 0, fallbackReason: "aborted" };
      } else {
        lastResult = {
          ok: false,
          appliedCount: 0,
          fallbackReason: "provider_error",
          error: err instanceof Error ? err.message : String(err),
        };
      }
      if (mi < models.length - 1) { clearTimeout(timeout); continue; }
      return lastResult!;
    } finally {
      clearTimeout(timeout);
    }
  }
  return lastResult ?? { ok: false, appliedCount: 0, fallbackReason: "provider_error", error: "All fallback models failed" };
}
