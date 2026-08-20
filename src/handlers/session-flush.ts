/**
 * Session flush — gives the agent one turn to save memories before context is lost.
 * Ported from hermes-agent/run_agent.py (flush_memories).
 * See PLAN.md → "Hermes Source File Reference Map" for source lines.
 *
 * Default transport: in-process direct completion (same mechanism as
 * background review — see review-memory-ops.ts). Falls back to a `pi -p`
 * subprocess only if direct mode fails or reviewTransport forces subprocess.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { DatabaseManager } from "../store/db.js";
import {
  buildMemoryTargetRoutingGuidance,
  DIRECT_FLUSH_SYSTEM_PROMPT,
  ENTRY_DELIMITER,
  FLUSH_PROMPT,
} from "../constants.js";
import type { MemoryConfig } from "../types.js";
import { collectMessageParts } from "./message-parts.js";
import { execChildPrompt, resolveChildPiModel } from "./pi-child-process.js";
import { runDirectMemoryCompletion, usesDirectTransport } from "./review-memory-ops.js";
import { resolveProjectName, resolveProjectStore, type ProjectNameRef, type ProjectStoreRef } from "../project-context.js";
import { isSubagentSession } from "./background-review.js";

function buildDirectFlushUserPrompt(
  store: MemoryStore,
  projectStore: MemoryStore | null,
  parts: string[],
): string {
  const sections = [
    "--- Current Memory ---",
    store.getMemoryEntries().join(ENTRY_DELIMITER) || "(empty)",
    "",
    "--- Current User Profile ---",
    store.getUserEntries().join(ENTRY_DELIMITER) || "(empty)",
  ];

  if (projectStore) {
    sections.push(
      "",
      "--- Current Project Memory ---",
      projectStore.getMemoryEntries().join(ENTRY_DELIMITER) || "(empty)",
    );
  }

  sections.push(
    "",
    "--- Conversation ---",
    parts.join("\n\n"),
  );

  return sections.join("\n");
}

export function setupSessionFlush(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: ProjectStoreRef,
  config: MemoryConfig,
  dbManager: DatabaseManager | null = null,
  projectName: ProjectNameRef = null,
  deps: { runDirectMemoryCompletion?: typeof runDirectMemoryCompletion } = {},
): void {
  let userTurnCount = 0;
  const runDirect = deps.runDirectMemoryCompletion ?? runDirectMemoryCompletion;

  pi.on("message_end", async (event, ctx) => {
    if (isSubagentSession(ctx)) return;
    if (event.message.role === "user") userTurnCount++;
  });

  /** Shared flush logic — builds conversation snapshot and saves memories */
  async function flush(
    ctx: Pick<ExtensionContext, "sessionManager" | "model" | "modelRegistry" | "cwd">,
    signal?: AbortSignal,
    timeoutMs = 30000,
  ): Promise<void> {
    if (isSubagentSession(ctx)) return;
    if (userTurnCount < config.flushMinTurns) return;

    let entries;
    try {
      entries = ctx.sessionManager.getBranch();
    } catch {
      return; // Context already stale
    }

    const parts = collectMessageParts(entries, config.flushRecentMessages);
    const activeProjectStore = resolveProjectStore(projectStore);
    const activeProjectName = resolveProjectName(projectName);

    if (usesDirectTransport(config)) {
      try {
        const directResult = await runDirect(
          ctx,
          store,
          activeProjectStore,
          {
            systemPrompt: [
              DIRECT_FLUSH_SYSTEM_PROMPT,
              "",
              buildMemoryTargetRoutingGuidance(activeProjectStore !== null),
            ].join("\n"),
            userPrompt: buildDirectFlushUserPrompt(store, activeProjectStore, parts),
            config,
            timeoutMs,
            signal,
          },
          dbManager,
          activeProjectName,
        );
        if (directResult.ok) return;
      } catch {
        // Fall through to subprocess below.
      }
    }

    const flushMessage = [
      FLUSH_PROMPT,
      "",
      buildMemoryTargetRoutingGuidance(activeProjectStore !== null),
      "",
      "--- Conversation ---",
      parts.join("\n\n"),
    ].join("\n");

    try {
      await execChildPrompt(pi, flushMessage, config, {
        cwd: ctx.cwd,
        model: resolveChildPiModel(ctx.model),
        signal,
        timeoutMs,
      });
    } catch {
      // Best-effort flush — never block compaction or shutdown.
    }
  }

  // Flush before compaction (can afford to wait)
  pi.on("session_before_compact", async (event, ctx) => {
    if (isSubagentSession(ctx)) return;
    if (!config.flushOnCompact) return;
    await flush(ctx, event.signal, 30000);
  });

  // Flush before session shutdown. Pi awaits async session_shutdown handlers
  // before invalidating the session, so await the bounded flush here.
  pi.on("session_shutdown", async (_event, ctx) => {
    if (isSubagentSession(ctx)) return;
    if (!config.flushOnShutdown) return;
    await flush(ctx, undefined, 10000);
  });
}
