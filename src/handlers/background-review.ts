/**
 * Background review — learning loop that auto-saves memory every N turns.
 * Ported from hermes-agent/run_agent.py (_spawn_background_review, _memory_nudge_interval).
 * See PLAN.md → "Hermes Source File Reference Map" for source lines.
 *
 * Default transport: in-process complete() side-channel (preserves parent LLM cache).
 * Fallback: pi.exec("pi", ["-p", ...]) subprocess when direct path is unavailable.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildMemoryTargetRoutingGuidance,
  COMBINED_REVIEW_PROMPT,
  DIRECT_REVIEW_SYSTEM_PROMPT,
} from "../constants.js";
import { MemoryStore } from "../store/memory-store.js";
import { DatabaseManager } from "../store/db.js";
import type { MemoryConfig } from "../types.js";
import { applyRecentMessageLimit, collectMessageParts } from "./message-parts.js";
import { execChildPrompt, resolveChildPiModel } from "./pi-child-process.js";
import { runDirectMemoryCompletion, usesDirectTransport, type DirectReviewResult } from "./review-memory-ops.js";

import { resolveProjectName, resolveProjectStore, type ProjectNameRef, type ProjectStoreRef } from "../project-context.js";

export function isSubagentSession(ctx: unknown): boolean {
  if (
    process.env.PI_SUBAGENT === "1" ||
    process.env.PI_SUBAGENT === "true" ||
    process.env.PI_IS_SUBAGENT === "1" ||
    process.env.PI_IS_SUBAGENT === "true" ||
    process.env.PI_AGENT_SUBAGENT === "1"
  ) {
    return true;
  }

  if (!ctx || typeof ctx !== "object") {
    return false;
  }

  const context = ctx as Record<string, unknown>;

  if (context.isSubagent === true || context.is_subagent === true || context.isSubagentSession === true) {
    return true;
  }

  if (typeof context.subagentType === "string" && context.subagentType.length > 0) {
    return true;
  }

  if (context.sessionMetadata && typeof context.sessionMetadata === "object") {
    const meta = context.sessionMetadata as Record<string, unknown>;
    if (meta.isSubagent === true || meta.is_subagent === true || meta.isSubagentSession === true) {
      return true;
    }
    if (typeof meta.subagentType === "string" && meta.subagentType.length > 0) {
      return true;
    }
    if (typeof meta.parentSessionId === "string" && meta.parentSessionId.length > 0) {
      return true;
    }
  }

  const sessionManager = context.sessionManager as Record<string, unknown> | undefined;
  if (sessionManager && typeof sessionManager === "object") {
    if (sessionManager.isSubagent === true || sessionManager.is_subagent === true) {
      return true;
    }
    if (typeof sessionManager.isSubagentSession === "function") {
      try {
        if ((sessionManager.isSubagentSession as () => boolean)()) return true;
      } catch {}
    }
    if (typeof sessionManager.getHeader === "function") {
      try {
        const header = (sessionManager.getHeader as () => Record<string, unknown> | null)();
        if (header && typeof header === "object") {
          if (header.isSubagent === true || header.is_subagent === true) {
            return true;
          }
          if (typeof header.parentSessionId === "string" && header.parentSessionId.length > 0) {
            return true;
          }
          if (typeof header.subagentType === "string" && header.subagentType.length > 0) {
            return true;
          }
        }
      } catch {}
    }
  }

  return false;
}

export interface BackgroundReviewOptions {
  dbManager?: DatabaseManager | null;
  projectName?: ProjectNameRef;
  deps?: BackgroundReviewDeps;
}

export interface BackgroundReviewDeps {
  runDirectReview?: typeof runDirectMemoryCompletion;
  execChildPrompt?: typeof execChildPrompt;
  /** Test-only hook: called once runReview() has fully settled (after the
   * fire-and-forget review work completes and reviewInProgress resets),
   * since production callers never await runReview() directly. */
  onReviewSettled?: () => void;
}

export interface ReviewPromptInput {
  parts: string[];
  currentMemory: string;
  currentUser: string;
  currentProject: string | null;
}

export function buildSubprocessReviewPrompt(input: ReviewPromptInput): string {
  const reviewPrompt = [
    COMBINED_REVIEW_PROMPT,
    "",
    buildMemoryTargetRoutingGuidance(input.currentProject !== null),
    "",
    "--- Current Memory ---",
    input.currentMemory || "(empty)",
    "",
    "--- Current User Profile ---",
    input.currentUser || "(empty)",
  ];

  if (input.currentProject !== null) {
    reviewPrompt.push(
      "",
      "--- Current Project Memory ---",
      input.currentProject || "(empty)",
    );
  }

  reviewPrompt.push(
    "",
    "--- Conversation to Review ---",
    input.parts.join("\n\n"),
  );

  return reviewPrompt.join("\n");
}

export function buildDirectReviewUserPrompt(input: ReviewPromptInput): string {
  const sections = [
    "--- Current Memory ---",
    input.currentMemory || "(empty)",
    "",
    "--- Current User Profile ---",
    input.currentUser || "(empty)",
  ];

  if (input.currentProject !== null) {
    sections.push(
      "",
      "--- Current Project Memory ---",
      input.currentProject || "(empty)",
    );
  }

  sections.push(
    "",
    "--- Conversation to Review ---",
    input.parts.join("\n\n"),
  );

  return sections.join("\n");
}

function shouldNotifyDirect(result: DirectReviewResult): boolean {
  return result.ok && result.appliedCount > 0;
}

function shouldNotifySubprocess(stdout: string | undefined): boolean {
  const output = stdout?.trim();
  return !!output && !output.toLowerCase().includes("nothing to save");
}

function diagnosticDetail(value: unknown): string {
  const detail = value instanceof Error ? value.message : String(value ?? "").trim();
  return detail.replace(/\s+/g, " ").slice(0, 300);
}

async function runSubprocessReview(
  pi: ExtensionAPI,
  prompt: string,
  config: MemoryConfig,
  execChild: typeof execChildPrompt,
  ctx: Pick<ExtensionContext, "cwd" | "model" | "signal">,
): Promise<{ code: number; stdout?: string; stderr?: string }> {
  return execChild(pi, prompt, config, {
    cwd: ctx.cwd,
    model: resolveChildPiModel(ctx.model),
    signal: ctx.signal,
    timeoutMs: 120000,
  });
}

export function setupBackgroundReview(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: ProjectStoreRef,
  config: MemoryConfig,
  options: BackgroundReviewOptions = {},
): void {
  const dbManager = options.dbManager ?? null;
  const projectName = options.projectName ?? null;
  const runDirectReview = options.deps?.runDirectReview ?? runDirectMemoryCompletion;
  const execChild = options.deps?.execChildPrompt ?? execChildPrompt;
  const onReviewSettled = options.deps?.onReviewSettled;

  let turnsSinceReview = 0;
  let toolCallsSinceReview = 0;
  let userTurnCount = 0;
  let reviewInProgress = false;

  pi.on("message_end", async (event, ctx) => {
    if (isSubagentSession(ctx)) return;
    if (event.message.role === "user") {
      userTurnCount++;
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    if (isSubagentSession(ctx)) return;

    turnsSinceReview++;

    if (!config.reviewEnabled) return;
    if (reviewInProgress) return;

    try {
      const msg = event.message;
      if (msg?.role === "assistant") {
        const content = msg?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === "object" && block.type === "toolCall") {
              toolCallsSinceReview++;
            }
          }
        }
      }
    } catch {
      // If we can't count tool calls, fall back to turn-based only
    }

    const turnThresholdMet = turnsSinceReview >= config.nudgeInterval;
    const toolCallThresholdMet = toolCallsSinceReview >= config.nudgeToolCalls;

    if (!turnThresholdMet && !toolCallThresholdMet) return;
    if (userTurnCount < 3) return;

    turnsSinceReview = 0;
    toolCallsSinceReview = 0;
    reviewInProgress = true;

    let allParts: string[] = [];
    try {
      const entries = ctx.sessionManager.getBranch();
      allParts = collectMessageParts(entries);
    } catch {
      reviewInProgress = false;
      return;
    }
    if (allParts.length < 4) {
      reviewInProgress = false;
      return;
    }

    const parts = applyRecentMessageLimit(allParts, config.reviewRecentMessages);
    const activeProjectStore = resolveProjectStore(projectStore);
    const activeProjectName = resolveProjectName(projectName);
    const promptInput: ReviewPromptInput = {
      parts,
      currentMemory: store.getMemoryEntries().join("\n§\n"),
      currentUser: store.getUserEntries().join("\n§\n"),
      currentProject: activeProjectStore ? activeProjectStore.getMemoryEntries().join("\n§\n") : null,
    };

    const subprocessPrompt = buildSubprocessReviewPrompt(promptInput);
    const directPrompt = buildDirectReviewUserPrompt(promptInput);

    const finishReview = () => {
      reviewInProgress = false;
      onReviewSettled?.();
    };

    const notifyIfSaved = (saved: boolean) => {
      if (saved) {
        ctx.ui.notify("💾 Memory auto-reviewed and updated", "info");
      }
    };

    const runReview = async (): Promise<void> => {
      let directFailure: string | undefined;

      if (usesDirectTransport(config)) {
        try {
          const directResult = await runDirectReview(
            ctx as Pick<ExtensionContext, "model" | "modelRegistry">,
            store,
            activeProjectStore,
            {
              userPrompt: directPrompt,
              systemPrompt: [
                DIRECT_REVIEW_SYSTEM_PROMPT,
                "",
                buildMemoryTargetRoutingGuidance(activeProjectStore !== null),
              ].join("\n"),
              config,
              timeoutMs: 120000,
            },
            dbManager,
            activeProjectName,
          );

          if (directResult.ok) {
            notifyIfSaved(shouldNotifyDirect(directResult));
            return;
          }

          if (directResult.fallbackReason === "empty") {
            return;
          }
          directFailure = [
            directResult.fallbackReason ?? "failed",
            directResult.error,
          ].filter(Boolean).join(": ");
        } catch (error) {
          directFailure = diagnosticDetail(error);
        }
      }

      let subprocessResult: { code: number; stdout?: string; stderr?: string };
      try {
        subprocessResult = await runSubprocessReview(pi, subprocessPrompt, config, execChild, ctx);
      } catch (error) {
        if (directFailure) {
          ctx.ui.notify(
            `Memory auto-review failed in both transports. Direct: ${diagnosticDetail(directFailure)}. `
              + `Subprocess: ${diagnosticDetail(error)}. Check the active model/provider or set llmModelOverride.`,
            "warning",
          );
        }
        return;
      }

      if (subprocessResult.code === 0) {
        notifyIfSaved(shouldNotifySubprocess(subprocessResult.stdout));
      } else if (directFailure) {
        const subprocessDetail = subprocessResult.stderr?.trim() || subprocessResult.stdout?.trim()
          || `exit code ${subprocessResult.code}`;
        ctx.ui.notify(
          `Memory auto-review failed in both transports. Direct: ${diagnosticDetail(directFailure)}. `
            + `Subprocess: ${diagnosticDetail(subprocessDetail)}. Check the active model/provider or set llmModelOverride.`,
          "warning",
        );
      }
    };

    runReview()
      .catch(() => {
        // Best-effort only; transport failures are diagnosed after both paths settle.
      })
      .finally(finishReview);
  });
}
