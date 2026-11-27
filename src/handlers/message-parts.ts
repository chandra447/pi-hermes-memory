import { userMessageFromEntry } from "../user-message.js";
import { getMessageText } from "../types.js";

export function applyRecentMessageLimit(parts: string[], recentMessages = 0): string[] {
  if (Number.isFinite(recentMessages) && recentMessages > 0) {
    return parts.slice(-recentMessages);
  }
  return parts;
}

export function collectMessageParts(entries: unknown[], recentMessages = 0, userMessageCustomTypes?: readonly string[]): string[] {
  const parts: string[] = [];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const msg = (entry as { type?: unknown }).type === "message"
      ? (entry as { message?: unknown }).message
      : userMessageFromEntry(entry, userMessageCustomTypes);
    const text = getMessageText(msg);
    if (!text) continue;

    const role = (msg as { role?: unknown } | null)?.role;
    const prefix = role === "user" ? "[USER]" : "[ASSISTANT]";
    parts.push(`${prefix}: ${text}`);
  }

  return applyRecentMessageLimit(parts, recentMessages);
}
