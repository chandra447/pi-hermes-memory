/**
 * Memory write tools — registers the LLM-callable memory_add, memory_replace,
 * and memory_remove tools.
 * See PLAN.md → "Hermes Source File Reference Map" for source lines.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { MemoryStore } from "../store/memory-store.js";
import { DatabaseManager } from "../store/db.js";
import {
  formatFailureMemoryContent,
  reconcileMarkdownFailureScopes,
  reconcileMarkdownMemoryScope,
  removeExactSyncedMemories,
  removeSyncedMemories,
  replaceSyncedMemories,
  syncMemoryEntry,
} from "../store/sqlite-memory-store.js";
import { MEMORY_TOOL_DESCRIPTION } from "../constants.js";
import { resolveProjectName, resolveProjectStore, type ProjectNameRef, type ProjectStoreRef } from "../project-context.js";
import type { MemoryCategory, MemoryResult } from "../types.js";
import { normalizeMemoryLookupText } from "../store/memory-lookup.js";
import { createSharedToolResultRenderer } from "./shared-output-view.js";
import { memoryResultView } from "./tool-result-views.js";

function appendSyncWarning(result: MemoryResult, warning: string): MemoryResult {
  const warnings = [...(((result as any).warnings ?? []) as string[]), warning];
  const message = result.message ? `${result.message} Warning: ${warning}` : warning;
  return {
    ...result,
    message,
    warning,
    warnings,
  } as MemoryResult;
}

function formatMemoryToolText(result: MemoryResult): string {
  const evictedEntries = result.evicted_entries ?? [];
  if (result.success && evictedEntries.length > 0) {
    const lines = [
      result.message ?? `Memory updated. Rotated ${evictedEntries.length} older ${evictedEntries.length === 1 ? "entry" : "entries"} to stay within the limit.`,
      "",
      "Rotated active memory entries:",
      "",
    ];

    evictedEntries.forEach((entry, index) => {
      lines.push(`${index + 1}. ${entry}`);
      lines.push("");
    });

    lines.push("If one of these entries should stay active, add it again.");
    if (result.usage) lines.push(`Usage: ${result.usage}`);
    return lines.join("\n").trim();
  }

  return JSON.stringify(result);
}

function sqliteProjectFor(rawTarget: "memory" | "user" | "project" | "failure", projectName?: string | null): string | null | undefined {
  if (rawTarget === "project") return projectName?.trim() || null;
  if (rawTarget === "memory") return null;
  if (rawTarget === "user") return null;
  if (rawTarget === "failure") return null;
  return undefined;
}

function sqliteTargetFor(rawTarget: "memory" | "user" | "project" | "failure"): "memory" | "user" | "failure" {
  if (rawTarget === "project") return "memory";
  return rawTarget;
}

function matchingMutationTargets(
  oldText: string,
  store: MemoryStore,
  projectStore: MemoryStore | null,
): Array<"memory" | "user" | "failure" | "project"> {
  const lookup = normalizeMemoryLookupText(oldText);
  if (!lookup) return [];

  const targets: Array<"memory" | "user" | "failure" | "project"> = [];
  if (store.getMemoryEntries().some((entry) => entry.includes(lookup))) targets.push("memory");
  if (store.getUserEntries().some((entry) => entry.includes(lookup))) targets.push("user");
  if (store.getAllFailureEntries().some((entry) => entry.includes(lookup))) targets.push("failure");
  if (projectStore?.getMemoryEntries().some((entry) => entry.includes(lookup))) targets.push("project");
  return targets;
}

function addWrongTargetHint(
  result: MemoryResult,
  rawTarget: "memory" | "user" | "project" | "failure",
  oldText: string,
  store: MemoryStore,
  projectStore: MemoryStore | null,
): MemoryResult {
  if (result.success || !result.error?.startsWith("No entry matched")) return result;

  const alternatives = matchingMutationTargets(oldText, store, projectStore)
    .filter((target) => target !== rawTarget);
  if (alternatives.length === 0) return result;

  const quotedTargets = alternatives.map((target) => `"${target}"`).join(", ");
  const noun = alternatives.length === 1 ? "target" : "targets";
  return {
    ...result,
    error: `No match in target "${rawTarget}"; matching entry found in ${noun} ${quotedTargets}. Retry with the displayed target.`,
    matching_targets: alternatives,
  };
}

async function syncAddToSqlite(
  rawTarget: "memory" | "user" | "project" | "failure",
  content: string,
  category: MemoryCategory | undefined,
  failureReason: string | undefined,
  dbManager: DatabaseManager | null,
  projectName?: string | null,
): Promise<string | null> {
  if (!dbManager) return null;

  try {
    const sqliteTarget = sqliteTargetFor(rawTarget);
    const sqliteProject = sqliteProjectFor(rawTarget, projectName);

    if (rawTarget === "failure") {
      const failureCategory = category ?? "failure";
      syncMemoryEntry(dbManager, {
        content: formatFailureMemoryContent(content, {
          category: failureCategory,
          failureReason,
        }),
        target: "failure",
        project: sqliteProject ?? null,
        category: failureCategory,
        failureReason,
      });
      return null;
    }

    syncMemoryEntry(dbManager, {
      content,
      target: sqliteTarget,
      project: sqliteProject ?? null,
    });
    return null;
  } catch (err) {
    return `Saved to Markdown, but SQLite search sync failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function syncReplaceToSqlite(
  rawTarget: "memory" | "user" | "project" | "failure",
  oldText: string,
  newContent: string,
  dbManager: DatabaseManager | null,
  projectName?: string | null,
): Promise<string | null> {
  if (!dbManager) return null;

  try {
    const sqliteTarget = sqliteTargetFor(rawTarget);
    const sqliteProject = sqliteProjectFor(rawTarget, projectName);
    const syncResult = replaceSyncedMemories(dbManager, oldText, {
      content: newContent,
      target: sqliteTarget,
      project: sqliteProject,
    });

    if (syncResult.matched === 0) {
      return "Saved to Markdown, but no matching SQLite memory row was updated. Run /memory-sync-markdown if search results look stale.";
    }

    return null;
  } catch (err) {
    return `Saved to Markdown, but SQLite search sync failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function syncRemoveFromSqlite(
  rawTarget: "memory" | "user" | "project" | "failure",
  oldText: string,
  dbManager: DatabaseManager | null,
  projectName?: string | null,
): Promise<string | null> {
  if (!dbManager) return null;

  try {
    const sqliteTarget = sqliteTargetFor(rawTarget);
    const sqliteProject = sqliteProjectFor(rawTarget, projectName);
    const syncResult = removeSyncedMemories(dbManager, oldText, {
      target: sqliteTarget,
      project: sqliteProject,
    });

    if (syncResult.matched === 0) {
      return "Saved to Markdown, but no matching SQLite memory row was removed. Run /memory-sync-markdown if search results look stale.";
    }

    return null;
  } catch (err) {
    return `Saved to Markdown, but SQLite search sync failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function syncEvictionsFromSqlite(
  rawTarget: "memory" | "user" | "project" | "failure",
  evictedEntries: string[] | undefined,
  dbManager: DatabaseManager | null,
  projectName?: string | null,
): Promise<void> {
  if (!dbManager) return;
  if (!evictedEntries || evictedEntries.length === 0) return;

  const sqliteTarget = sqliteTargetFor(rawTarget);
  const sqliteProject = sqliteProjectFor(rawTarget, projectName);

  for (const entry of evictedEntries) {
    try {
      removeExactSyncedMemories(dbManager, entry, {
        target: sqliteTarget,
        project: sqliteProject,
      });
    } catch {
      // FIFO already updated the Markdown source of truth. SQLite is only a
      // best-effort search mirror, so eviction cleanup must not fail the write.
    }
  }
}

async function reconcileStoreScope(
  entries: string[],
  rawTarget: "memory" | "user" | "project" | "failure",
  dbManager: DatabaseManager | null,
  projectName?: string | null,
): Promise<string | null | undefined> {
  if (!dbManager) return undefined;
  try {
    if (rawTarget === "failure") {
      reconcileMarkdownFailureScopes(dbManager, entries);
      return null;
    }
    const target = sqliteTargetFor(rawTarget);
    reconcileMarkdownMemoryScope(
      dbManager,
      entries,
      target,
      sqliteProjectFor(rawTarget, projectName) ?? null,
    );
    return null;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const msg = detail.toLowerCase();
    if (msg.includes('fts5') || msg.includes('malformed') || msg.includes('sql logic error') || msg.includes('unterminated')) {
      return `Saved to Markdown. Search may be temporarily unavailable (FTS5 error); try /memory-sync-markdown to re-index.`;
    }
    return `Saved to Markdown, but SQLite search reconciliation failed: ${detail}`;
  }
}

type MemoryAction = "add" | "replace" | "remove";

type MemoryToolParams = {
  target: "memory" | "user" | "project" | "failure";
  content?: string;
  old_text?: string;
  category?: MemoryCategory;
  failure_reason?: string;
};
export function registerMemoryTool(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: ProjectStoreRef,
  dbManager: DatabaseManager | null = null,
  projectName: ProjectNameRef = null,
): (candidate: MemoryStore | null) => void {
  const reconciledStores = new WeakSet<MemoryStore>();
  const attachMutationObserver = (candidate: MemoryStore | null, isProjectStore = false): void => {
    if (!candidate || reconciledStores.has(candidate) || typeof candidate.setMutationObserver !== "function") return;
    candidate.setMutationObserver((target, entries) =>
      reconcileStoreScope(
        entries,
        isProjectStore && target === "memory" ? "project" : target,
        dbManager,
        resolveProjectName(projectName),
      ),
    );
    reconciledStores.add(candidate);
  };
  const configureProjectStore = (candidate: MemoryStore | null): void => {
    attachMutationObserver(candidate, true);
  };
  attachMutationObserver(store);
  configureProjectStore(resolveProjectStore(projectStore));

  if (typeof pi.on === "function") {
    pi.on("tool_result", (event) => {
      if (!event.toolName.startsWith("memory_")) return;
      const details = event.details as { success?: unknown } | undefined;
      if (details?.success === false) return { isError: true };
    });
  }

  const executeAction = async (
    action: MemoryAction,
    params: MemoryToolParams,
    signal?: AbortSignal,
  ) => {
    const { target: rawTarget, content, old_text, category, failure_reason } = params;
    const target = rawTarget === "project" ? "memory" : rawTarget;
    const activeProjectStore = resolveProjectStore(projectStore);
    const activeProjectName = resolveProjectName(projectName);
    const activeStore = rawTarget === "project" ? activeProjectStore : store;

    if (rawTarget === "project" && !activeProjectStore) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            error: "Project memory is not available (no project detected).",
          }),
        }],
        details: {
          success: false,
          error: "Project memory is not available (no project detected).",
        },
      };
    }

    const store_ = activeStore!;
    attachMutationObserver(store_);
    let result: MemoryResult;
    let syncWarning: string | null = null;
    const syncHandled = reconciledStores.has(store_);

    switch (action) {
      case "add":
        if (!content) {
          throw new Error("Content is required for 'add' action.");
        }
        if (rawTarget === "failure") {
          const memoryCategory = category ?? "failure";
          result = await store_.addFailure(content, {
            category: memoryCategory,
            failureReason: failure_reason,
          });
          if (result.success && !syncHandled) {
            syncWarning = await syncAddToSqlite(rawTarget, content, memoryCategory, failure_reason, dbManager, activeProjectName);
          }
        } else {
          result = await store_.add(target, content, signal);
          if (result.success && !syncHandled) {
            await syncEvictionsFromSqlite(rawTarget, result.evicted_entries, dbManager, activeProjectName);
            syncWarning = await syncAddToSqlite(rawTarget, content, undefined, undefined, dbManager, activeProjectName);
          }
        }
        break;
      case "replace":
        if (!old_text) throw new Error("old_text is required for 'replace' action.");
        if (!content) throw new Error("content is required for 'replace' action.");
        result = await store_.replace(target, old_text, content);
        if (result.success && !syncHandled) {
          syncWarning = await syncReplaceToSqlite(rawTarget, old_text, content, dbManager, activeProjectName);
        }
        break;
      case "remove":
        if (!old_text) throw new Error("old_text is required for 'remove' action.");
        result = await store_.remove(target, old_text);
        if (result.success && !syncHandled) {
          syncWarning = await syncRemoveFromSqlite(rawTarget, old_text, dbManager, activeProjectName);
        }
        break;
    }

    if (action !== "add" && old_text) {
      result = addWrongTargetHint(result, rawTarget, old_text, store, activeProjectStore);
    }

    if (result.success && !syncHandled && typeof store_.getRawEntriesForSync === "function") {
      const reconciliationWarning = await reconcileStoreScope(store_.getRawEntriesForSync(target), rawTarget, dbManager, activeProjectName);
      if (reconciliationWarning !== undefined) syncWarning = reconciliationWarning;
    }

    if (syncWarning && result.success) result = appendSyncWarning(result, syncWarning);
    if (rawTarget === "project" && result.success) result = { ...result, target: "project" };

    return {
      content: [{ type: "text" as const, text: formatMemoryToolText(result) }],
      details: result,
    };
  };

  const commonDescription = `${MEMORY_TOOL_DESCRIPTION}

This action-specific tool accepts only the parameters listed in its schema.`;

  const registerActionTool = (
    action: MemoryAction,
    name: string,
    label: string,
    description: string,
    parameters: TSchema,
  ) => {
    pi.registerTool({
      name,
      label,
      description,
      promptSnippet: `${label}: persistent memory that survives across sessions`,
      promptGuidelines: [
        "Use this tool proactively when the user corrects you, shares a preference, or reveals durable environment or project facts.",
        "Do not use memory tools for temporary task state, TODO items, or session progress.",
      ],
      renderResult: createSharedToolResultRenderer(memoryResultView),
      parameters,
      async execute(_toolCallId, params, signal) {
        return executeAction(action, params as MemoryToolParams, signal);
      },
    });
  };

  const target = StringEnum(["memory", "user", "project", "failure"] as const, {
    description: "Memory scope. Use failure for failures, corrections, insights, and tool quirks.",
  });
  const category = StringEnum(["failure", "correction", "insight", "preference", "convention", "tool-quirk"] as const, {
    description: "Category for failure memories.",
  });

  registerActionTool(
    "add",
    "memory_add",
    "Memory Add",
    `${commonDescription}

Add one durable entry. The target and content fields are required.`,
    Type.Object({
      target,
      content: Type.String({ description: "Entry content to save." }),
      category: Type.Optional(category),
      failure_reason: Type.Optional(Type.String({ description: "Why a failure occurred." })),
    }),
  );
  registerActionTool(
    "replace",
    "memory_replace",
    "Memory Replace",
    `${commonDescription}

Replace one existing entry. The target, old_text, and content fields are required.`,
    Type.Object({
      target,
      old_text: Type.String({ description: "Substring identifying the entry to replace." }),
      content: Type.String({ description: "Replacement entry content." }),
    }),
  );
  registerActionTool(
    "remove",
    "memory_remove",
    "Memory Remove",
    `${commonDescription}

Remove one existing entry. The target and old_text fields are required.`,
    Type.Object({
      target,
      old_text: Type.String({ description: "Substring identifying the entry to remove." }),
    }),
  );
  return configureProjectStore;
}
