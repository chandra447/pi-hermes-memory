import { createHash } from "node:crypto";
import { DatabaseManager } from "./db.js";
import { addCandidate, type CandidateSourceType } from "./candidate-store.js";

interface MessageRow {
  id: string | null;
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  tool_calls: string | null;
  project: string;
}

interface CandidateDraft {
  sessionId: string;
  messageId: string | null;
  project: string;
  tag: string;
  snippet: string;
  rationale: string;
  confidence: number;
  sourceType: CandidateSourceType;
  extractorRule: string;
  timestamp: string;
  evidenceCount: number;
}

export interface CandidateExtractionResult {
  sessionsScanned: number;
  messagesScanned: number;
  candidatesAdded: number;
  duplicatesSkipped: number;
  byRule: Record<string, number>;
}

const EXPLICIT_TAG_PATTERN = /(^|\s)(#learn|#skill)\b/i;
const CORRECTION_PATTERN = /^(no|wrong|actually|i said|i told you|don'?t|please don'?t)\b/i;
const CORRECTION_NEGATIVE_PATTERN = /^(no worries|no problem|no need|no thanks|actually\s+looks?\s+great)\b/i;
const FAILURE_PATTERN = /(error|failed|failing|doesn'?t work|broken|exception|issue|traceback)/i;
const SUCCESS_PATTERN = /(fixed|resolved|works?|working|passed|done|patched|updated|success)/i;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function shortSnippet(text: string, max = 180): string {
  const normalized = normalizeWhitespace(text);
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function fallbackMessageId(row: MessageRow): string {
  if (row.id) return row.id;
  return `hash:${hashText([row.session_id, row.timestamp, row.role, row.content].join("|"))}`;
}

function extractDirective(text: string): string {
  return normalizeWhitespace(
    text
      .replace(/^(no|wrong|actually|i said|i told you|don'?t|please don'?t)[,\s.!-]*/i, "")
      .trim(),
  );
}

function makeDedupeKey(sessionId: string, messageId: string | null, tag: string, extractorRule: string, snippet: string): string {
  const messagePart = messageId ?? `hash:${hashText([sessionId, tag, extractorRule, snippet].join('|'))}`;
  return [sessionId, messagePart, tag, extractorRule].join('|');
}

function inferTag(text: string): string {
  const lower = text.toLowerCase();
  if (/\b(test|jest|vitest|tsx --test|assert)\b/.test(lower)) return "testing";
  if (/\b(migration|schema|sqlite|postgres|database|column|table)\b/.test(lower)) return "migration";
  if (/\btypescript|tsconfig|type error|strict\b/.test(lower)) return "typescript";
  if (/\bpnpm|npm|yarn|package\.json|lockfile\b/.test(lower)) return "package-manager";
  if (/\b(auth|token|permission|oauth|session)\b/.test(lower)) return "auth";
  return "workflow";
}

function parseToolCalls(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function extractExplicitTagCandidates(messages: MessageRow[]): CandidateDraft[] {
  const out: CandidateDraft[] = [];

  for (const msg of messages) {
    if (!EXPLICIT_TAG_PATTERN.test(msg.content)) continue;
    out.push({
      sessionId: msg.session_id,
      messageId: fallbackMessageId(msg),
      project: msg.project,
      tag: inferTag(msg.content),
      snippet: shortSnippet(msg.content),
      rationale: 'Message explicitly tagged for learning/skill capture',
      confidence: 0.92,
      sourceType: 'explicit_tag',
      extractorRule: 'explicit_tag',
      timestamp: msg.timestamp,
      evidenceCount: 1,
    });
  }

  return out;
}

function extractRepeatedCorrectionCandidates(messages: MessageRow[]): CandidateDraft[] {
  const directiveMap = new Map<string, { count: number; latest: MessageRow }>();

  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const text = normalizeWhitespace(msg.content);
    if (!text) continue;
    if (CORRECTION_NEGATIVE_PATTERN.test(text)) continue;
    if (!CORRECTION_PATTERN.test(text)) continue;

    const directive = extractDirective(text) || text;
    const prev = directiveMap.get(directive);
    if (prev) {
      prev.count += 1;
      prev.latest = msg;
    } else {
      directiveMap.set(directive, { count: 1, latest: msg });
    }
  }

  const out: CandidateDraft[] = [];
  for (const [directive, info] of directiveMap.entries()) {
    if (info.count < 2) continue;
    const conf = Math.min(0.9, 0.68 + info.count * 0.08);

    out.push({
      sessionId: info.latest.session_id,
      messageId: fallbackMessageId(info.latest),
      project: info.latest.project,
      tag: inferTag(directive),
      snippet: shortSnippet(directive),
      rationale: `Repeated correction observed ${info.count} times`,
      confidence: conf,
      sourceType: "correction",
      extractorRule: "repeated_correction",
      timestamp: info.latest.timestamp,
      evidenceCount: info.count,
    });
  }

  return out;
}

function findNextAssistant(messages: MessageRow[], startIndex: number, window = 5): MessageRow | null {
  const end = Math.min(messages.length, startIndex + window + 1);
  for (let i = startIndex + 1; i < end; i++) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return null;
}

function extractFailureFixCandidates(messages: MessageRow[]): CandidateDraft[] {
  const out: CandidateDraft[] = [];

  for (let i = 0; i < messages.length; i++) {
    const userMsg = messages[i];
    if (!userMsg || userMsg.role !== "user") continue;
    if (!FAILURE_PATTERN.test(userMsg.content)) continue;

    const assistant = findNextAssistant(messages, i, 5);
    if (!assistant) continue;
    if (!SUCCESS_PATTERN.test(assistant.content)) continue;

    out.push({
      sessionId: assistant.session_id,
      messageId: fallbackMessageId(assistant),
      project: assistant.project,
      tag: inferTag(`${userMsg.content} ${assistant.content}`),
      snippet: shortSnippet(`${shortSnippet(userMsg.content, 120)} -> ${shortSnippet(assistant.content, 120)}`),
      rationale: "Detected failure report followed by assistant fix/confirmation",
      confidence: 0.84,
      sourceType: "failure",
      extractorRule: "failure_fix_pair",
      timestamp: assistant.timestamp,
      evidenceCount: 2,
    });
  }

  return out;
}

function extractRepeatedToolSequenceCandidates(messages: MessageRow[]): CandidateDraft[] {
  const toolSeqMap = new Map<string, { count: number; sample: MessageRow }>();

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const tools = parseToolCalls(msg.tool_calls);
    if (tools.length === 0) continue;
    if (!SUCCESS_PATTERN.test(msg.content)) continue;

    const seq = tools.join(" > ");
    const prev = toolSeqMap.get(seq);
    if (prev) prev.count += 1;
    else toolSeqMap.set(seq, { count: 1, sample: msg });
  }

  const out: CandidateDraft[] = [];
  for (const [seq, info] of toolSeqMap.entries()) {
    if (info.count < 2) continue;

    out.push({
      sessionId: info.sample.session_id,
      messageId: fallbackMessageId(info.sample),
      project: info.sample.project,
      tag: "workflow",
      snippet: shortSnippet(`${seq} :: ${info.sample.content}`),
      rationale: `Repeated successful tool sequence observed ${info.count} times`,
      confidence: 0.78,
      sourceType: "tool_sequence",
      extractorRule: "repeated_tool_sequence",
      timestamp: info.sample.timestamp,
      evidenceCount: info.count,
    });
  }

  return out;
}

function groupMessagesBySession(rows: MessageRow[]): Map<string, MessageRow[]> {
  const grouped = new Map<string, MessageRow[]>();
  for (const row of rows) {
    if (!grouped.has(row.session_id)) grouped.set(row.session_id, []);
    grouped.get(row.session_id)!.push(row);
  }
  return grouped;
}

export function extractCandidatesFromIndexedMessages(dbManager: DatabaseManager): CandidateExtractionResult {
  const db = dbManager.getDb();

  const rows = db.prepare(`
    SELECT
      m.id,
      m.session_id,
      m.role,
      m.content,
      m.timestamp,
      m.tool_calls,
      s.project
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    ORDER BY m.session_id, m.timestamp ASC
  `).all() as MessageRow[];

  const grouped = groupMessagesBySession(rows);
  const byRule = new Map<string, number>();

  let candidatesAdded = 0;
  let duplicatesSkipped = 0;

  for (const [, messages] of grouped.entries()) {
    const drafts: CandidateDraft[] = [
      ...extractExplicitTagCandidates(messages),
      ...extractRepeatedCorrectionCandidates(messages),
      ...extractFailureFixCandidates(messages),
      ...extractRepeatedToolSequenceCandidates(messages),
    ];

    for (const draft of drafts) {
      const result = addCandidate(dbManager, {
        sessionId: draft.sessionId,
        messageId: draft.messageId,
        project: draft.project,
        tag: draft.tag,
        snippet: draft.snippet,
        rationale: draft.rationale,
        confidence: draft.confidence,
        sourceType: draft.sourceType,
        extractorRule: draft.extractorRule,
        timestamp: draft.timestamp,
        evidenceCount: draft.evidenceCount,
        dedupeKey: makeDedupeKey(draft.sessionId, draft.messageId, draft.tag, draft.extractorRule, draft.snippet),
      });

      if (result) {
        candidatesAdded++;
        byRule.set(draft.extractorRule, (byRule.get(draft.extractorRule) ?? 0) + 1);
      } else {
        duplicatesSkipped++;
      }
    }
  }

  return {
    sessionsScanned: grouped.size,
    messagesScanned: rows.length,
    candidatesAdded,
    duplicatesSkipped,
    byRule: Object.fromEntries(byRule.entries()),
  };
}
