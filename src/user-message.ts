import type { UserMessage } from "@earendil-works/pi-ai";
import { convertToLlm, type CustomMessageEntry, type SessionMessageEntry } from "@earendil-works/pi-coding-agent";

type AgentMessage = SessionMessageEntry["message"];

/** Only host-designated input types carry user intent at the memory boundary. */
export function projectUserMessage(message: AgentMessage, types: readonly string[] = []): UserMessage | undefined {
  if (message.role === "user") return message;
  if (message.role !== "custom" || !types.includes(message.customType)) return undefined;
  const [projected] = convertToLlm([message]);
  return projected?.role === "user" ? projected : undefined;
}

export function userMessageFromEntry(value: unknown, types?: readonly string[]): UserMessage | undefined {
  const entry = value as Partial<CustomMessageEntry> | null;
  if (
    entry?.type !== "custom_message" || typeof entry.customType !== "string" ||
    typeof entry.timestamp !== "string" || (typeof entry.content !== "string" && !Array.isArray(entry.content))
  ) return undefined;

  return projectUserMessage({
    role: "custom",
    customType: entry.customType,
    content: entry.content,
    display: entry.display === true,
    timestamp: Date.parse(entry.timestamp),
  }, types);
}
