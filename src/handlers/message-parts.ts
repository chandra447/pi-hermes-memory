import { getMessageText } from "../types.js";

export function applyRecentMessageLimit(
  parts: string[],
  recentMessages = 0,
): string[] {
  if (Number.isFinite(recentMessages) && recentMessages > 0) {
    return parts.slice(-recentMessages);
  }
  return parts;
}

export function collectMessageParts(
  entries: unknown[],
  recentMessages = 0,
): string[] {
  const parts: string[] = [];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    if ((entry as { type?: unknown }).type !== "message") continue;

    const msg = (entry as { message?: unknown }).message;
    const text = getMessageText(msg);
    if (!text) continue;

    const role = (msg as { role?: unknown } | null)?.role;
    const prefix = role === "user" ? "[USER]" : "[ASSISTANT]";
    parts.push(`${prefix}: ${text}`);
  }

  return applyRecentMessageLimit(parts, recentMessages);
}

export function collectLlmMessageParts(
  messages: unknown[],
  recentMessages = 0,
): string[] {
  const parts: string[] = [];

  for (const message of messages) {
    // Intentional 5000-char limit: the subprocess prompt must preserve long
    // compaction/branch summaries instead of the legacy 500-char default.
    const text = getMessageText(message, 5000);
    if (!text) continue;

    const role = (message as { role?: unknown } | null)?.role;
    const prefix =
      role === "user"
        ? "[USER]"
        : role === "toolResult"
          ? "[TOOL]"
          : "[ASSISTANT]";
    parts.push(`${prefix}: ${text}`);
  }

  return applyRecentMessageLimit(parts, recentMessages);
}

export function buildMemoryPromptSections(
  currentMemory: string,
  currentUser: string,
  currentProject: string | null,
): string[] {
  const sections = [
    "--- Current Memory ---",
    currentMemory || "(empty)",
    "",
    "--- Current User Profile ---",
    currentUser || "(empty)",
  ];

  if (currentProject !== null) {
    sections.push(
      "",
      "--- Current Project Memory ---",
      currentProject || "(empty)",
    );
  }

  return sections;
}

export function appendPromptConversationSection(
  sections: string[],
  parts: string[],
  heading: string,
): string[] {
  return [...sections, "", `--- ${heading} ---`, parts.join("\n\n")];
}
