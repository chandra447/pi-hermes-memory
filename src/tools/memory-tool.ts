/**
 * Memory tool — registers the LLM-callable `memory` tool.
 * Ported from hermes-agent/tools/memory_tool.py (MEMORY_SCHEMA + memory_tool dispatch).
 * See PLAN.md → "Hermes Source File Reference Map" for source lines.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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
import type { MemoryCategory, MemoryResult } from "../types.js";

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
    return `Saved to Markdown, but SQLite search reconciliation failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function registerMemoryTool(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  dbManager: DatabaseManager | null = null,
  projectName?: string | null,
): void {
  const reconciledStores = new WeakSet<MemoryStore>();
  if (typeof store.setMutationObserver === "function") {
    store.setMutationObserver((target, entries) => reconcileStoreScope(entries, target, dbManager, projectName));
    reconciledStores.add(store);
  }
  if (projectStore && typeof projectStore.setMutationObserver === "function") {
    projectStore.setMutationObserver((_target, entries) => reconcileStoreScope(entries, "project", dbManager, projectName));
    reconciledStores.add(projectStore);
  }

  pi.registerTool({
    name: "memory",
    label: "Memory",
    description: MEMORY_TOOL_DESCRIPTION,
    promptSnippet:
      "Save or manage persistent memory that survives across sessions",
    promptGuidelines: [
      "Use the memory tool proactively when the user corrects you, shares a preference, or reveals personal details worth remembering.",
      "Use the memory tool when you discover environment facts, project conventions, or reusable patterns useful in future sessions.",
      "Do NOT use memory for temporary task state, TODO items, or session progress — only for durable, cross-session facts.",
      "Use target='failure' with category to save what didn't work (failures, corrections, insights).",
    ],
    parameters: Type.Object({
      action: StringEnum(["add", "replace", "remove"] as const),
      target: StringEnum(["memory", "user", "project", "failure"] as const),
      content: Type.Optional(
        Type.String({ description: "Entry content for add/replace" })
      ),
      old_text: Type.Optional(
        Type.String({
          description:
            "Substring identifying entry for replace/remove",
        })
      ),
      category: Type.Optional(
        StringEnum(["failure", "correction", "insight", "preference", "convention", "tool-quirk"] as const, {
          description: "Category for failure memories",
        })
      ),
      failure_reason: Type.Optional(
        Type.String({ description: "Why it failed (for failure category)" })
      ),
      dry_run: Type.Optional(
        Type.Boolean({
          description:
            "Validate the operation without writing to disk or SQLite. Returns the same success/error shape; storage unchanged. Use to verify a save before committing.",
        })
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { action, target: rawTarget, content, old_text, category, failure_reason, dry_run } = params;
      const dryRun = dry_run === true;

      // Route 'project' to projectStore using the normal MEMORY.md target.
      const target = rawTarget === "project" ? "memory" : rawTarget as "memory" | "user" | "failure";
      const activeStore = rawTarget === "project" ? projectStore : store;

      if (rawTarget === "project" && !projectStore) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: "Project memory is not available (no project detected)." }) }],
          details: {},
        };
      }

      // After the guard above, activeStore is guaranteed non-null when rawTarget === 'project'
      const store_ = activeStore!;

      let result: MemoryResult;
      let syncWarning: string | null = null;
      const syncHandled = reconciledStores.has(store_);
      switch (action) {
        case "add":
          if (!content) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: "Content is required for 'add' action.",
                  }),
                },
              ],
              details: {},
            };
          }
          // Handle failure target with category
          if (rawTarget === "failure") {
            const memoryCategory = (category || "failure") as MemoryCategory;
            result = await store_.addFailure(content, {
              category: memoryCategory,
              failureReason: failure_reason,
              dryRun,
            });
            // Dry-run: skip SQLite sync entirely (validation only, no side effects).
            if (result.success && !syncHandled && !dryRun) {
              syncWarning = await syncAddToSqlite(rawTarget, content, memoryCategory, failure_reason, dbManager, projectName);
            }
          } else {
            result = await store_.add(target, content, signal, { dryRun });
            if (result.success && !syncHandled && !dryRun) {
              await syncEvictionsFromSqlite(rawTarget, result.evicted_entries, dbManager, projectName);
              syncWarning = await syncAddToSqlite(rawTarget, content, undefined, undefined, dbManager, projectName);
            }
          }
          break;

        case "replace":
          if (!old_text) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: "old_text is required for 'replace' action.",
                  }),
                },
              ],
              details: {},
            };
          }
          if (!content) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: "content is required for 'replace' action.",
                  }),
                },
              ],
              details: {},
            };
          }
          result = await store_.replace(target, old_text, content, { dryRun });
          if (result.success && !syncHandled && !dryRun) syncWarning = await syncReplaceToSqlite(rawTarget, old_text, content, dbManager, projectName);
          break;

        case "remove":
          if (!old_text) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: "old_text is required for 'remove' action.",
                  }),
                },
              ],
              details: {},
            };
          }
          result = await store_.remove(target, old_text, { dryRun });
          if (result.success && !syncHandled && !dryRun) syncWarning = await syncRemoveFromSqlite(rawTarget, old_text, dbManager, projectName);
          break;

        default:
          result = {
            success: false,
            error: `Unknown action '${action}'. Use: add, replace, remove`,
          };
      }

      if (result.success && !syncHandled && typeof store_.getRawEntriesForSync === "function") {
        const reconciliationWarning = await reconcileStoreScope(store_.getRawEntriesForSync(target), rawTarget, dbManager, projectName);
        if (reconciliationWarning !== undefined) syncWarning = reconciliationWarning;
      }

      if (syncWarning && result.success) {
        result = appendSyncWarning(result, syncWarning);
      }

      // Tag project results so the caller knows the scope
      if (rawTarget === "project" && result.success) {
        result = {
          ...result,
          target: "project",
        };
      }

      return {
        content: [{ type: "text", text: formatMemoryToolText(result) }],
        details: result,
      };
    },
  });
}
