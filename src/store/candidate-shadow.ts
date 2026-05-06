import path from "node:path";
import { createHash } from "node:crypto";
import { getSessionFiles, parseSessionFile, type ParsedMessage, type ParsedSession } from "./session-parser.js";

export type CandidateSourceType = "correction" | "failure" | "tool_sequence" | "explicit_tag";

export interface ShadowCandidate {
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

export interface ShadowRuleCount {
  rule: string;
  count: number;
}

export interface CandidateShadowReport {
  filesScanned: number;
  sessionsScanned: number;
  rawCandidateCount: number;
  candidateCount: number;
  duplicateCount: number;
  duplicateRate: number;
  lowConfidenceCount: number;
  lowConfidenceRate: number;
  topRules: ShadowRuleCount[];
  errors: string[];
}

const STAGE_CONFIDENCE_THRESHOLD = 0.75;

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

function extractDirective(text: string): string {
  return normalizeWhitespace(
    text
      .replace(/^(no|wrong|actually|i said|i told you|don'?t|please don'?t)[,\s.!-]*/i, "")
      .trim(),
  );
}

function inferTag(text: string): string {
  const lower = text.toLowerCase();
  if (/\b(test|jest|vitest|tsx --test|assert)\b/.test(lower)) return "testing";
  if (/\b(migration|schema|sqlite|postgres|database|column|table)\b/.test(lower)) return "migration";
  if (/\btypescript|tsconfig|type error|strict\b/.test(lower)) return "typescript";
  if (/\bpnpm|npm|yarn|package.json|lockfile\b/.test(lower)) return "package-manager";
  if (/\bauth|token|permission|oauth|session\b/.test(lower)) return "auth";
  return "workflow";
}

function makeDedupeKey(candidate: ShadowCandidate): string {
  const messagePart = candidate.messageId ?? `hash:${hashText(candidate.snippet)}`;
  return [
    candidate.sessionId,
    messagePart,
    candidate.tag,
    candidate.sourceType,
    candidate.extractorRule,
  ].join("|");
}

function findNextAssistant(messages: ParsedMessage[], startIndex: number, window = 4): ParsedMessage | null {
  const end = Math.min(messages.length, startIndex + window + 1);
  for (let i = startIndex + 1; i < end; i++) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return null;
}

function extractExplicitTagCandidates(session: ParsedSession): ShadowCandidate[] {
  const out: ShadowCandidate[] = [];

  for (const msg of session.messages) {
    if (!EXPLICIT_TAG_PATTERN.test(msg.content)) continue;

    out.push({
      sessionId: session.id,
      messageId: msg.id,
      project: session.project,
      tag: inferTag(msg.content),
      snippet: shortSnippet(msg.content),
      rationale: "Message explicitly tagged for learning/skill capture",
      confidence: 0.92,
      sourceType: "explicit_tag",
      extractorRule: "explicit_tag",
      timestamp: msg.timestamp,
      evidenceCount: 1,
    });
  }

  return out;
}

function extractRepeatedCorrectionCandidates(session: ParsedSession): ShadowCandidate[] {
  const directiveMap = new Map<string, { count: number; latest: ParsedMessage }>();

  for (const msg of session.messages) {
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

  const out: ShadowCandidate[] = [];
  for (const [directive, info] of directiveMap.entries()) {
    if (info.count < 2) continue;
    const conf = Math.min(0.9, 0.68 + info.count * 0.08);

    out.push({
      sessionId: session.id,
      messageId: info.latest.id,
      project: session.project,
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

function extractFailureFixCandidates(session: ParsedSession): ShadowCandidate[] {
  const out: ShadowCandidate[] = [];

  for (let i = 0; i < session.messages.length; i++) {
    const userMsg = session.messages[i];
    if (!userMsg || userMsg.role !== "user") continue;
    if (!FAILURE_PATTERN.test(userMsg.content)) continue;

    const assistant = findNextAssistant(session.messages, i, 5);
    if (!assistant) continue;
    if (!SUCCESS_PATTERN.test(assistant.content)) continue;

    const combined = `${shortSnippet(userMsg.content, 120)} -> ${shortSnippet(assistant.content, 120)}`;
    out.push({
      sessionId: session.id,
      messageId: assistant.id,
      project: session.project,
      tag: inferTag(`${userMsg.content} ${assistant.content}`),
      snippet: combined,
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

function extractRepeatedToolSequenceCandidates(session: ParsedSession): ShadowCandidate[] {
  const toolSeqMap = new Map<string, { count: number; sample: ParsedMessage }>();

  for (const msg of session.messages) {
    if (msg.role !== "assistant") continue;
    if (!msg.toolCalls || msg.toolCalls.length === 0) continue;
    if (!SUCCESS_PATTERN.test(msg.content)) continue;

    const seq = msg.toolCalls.join(" > ");
    const prev = toolSeqMap.get(seq);
    if (prev) {
      prev.count += 1;
    } else {
      toolSeqMap.set(seq, { count: 1, sample: msg });
    }
  }

  const out: ShadowCandidate[] = [];
  for (const [seq, info] of toolSeqMap.entries()) {
    if (info.count < 2) continue;

    out.push({
      sessionId: session.id,
      messageId: info.sample.id,
      project: session.project,
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

export function extractShadowCandidatesFromSession(session: ParsedSession): ShadowCandidate[] {
  return [
    ...extractExplicitTagCandidates(session),
    ...extractRepeatedCorrectionCandidates(session),
    ...extractFailureFixCandidates(session),
    ...extractRepeatedToolSequenceCandidates(session),
  ];
}

export function buildCandidateShadowReport(sessionsDir: string): CandidateShadowReport {
  const files = getSessionFiles(sessionsDir);
  const errors: string[] = [];

  const seen = new Set<string>();
  const ruleCounts = new Map<string, number>();

  let sessionsScanned = 0;
  let rawCandidateCount = 0;
  let candidateCount = 0;
  let duplicateCount = 0;
  let lowConfidenceCount = 0;

  for (const file of files) {
    try {
      const session = parseSessionFile(file);
      if (!session) {
        errors.push(`Failed to parse: ${path.basename(file)}`);
        continue;
      }

      sessionsScanned++;
      const candidates = extractShadowCandidatesFromSession(session);
      rawCandidateCount += candidates.length;

      for (const candidate of candidates) {
        const dedupeKey = makeDedupeKey(candidate);
        if (seen.has(dedupeKey)) {
          duplicateCount++;
          continue;
        }

        seen.add(dedupeKey);
        candidateCount++;

        if (candidate.confidence < STAGE_CONFIDENCE_THRESHOLD) {
          lowConfidenceCount++;
        }

        ruleCounts.set(candidate.extractorRule, (ruleCounts.get(candidate.extractorRule) ?? 0) + 1);
      }
    } catch (err) {
      errors.push(`Error scanning ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const topRules = Array.from(ruleCounts.entries())
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    filesScanned: files.length,
    sessionsScanned,
    rawCandidateCount,
    candidateCount,
    duplicateCount,
    duplicateRate: rawCandidateCount > 0 ? duplicateCount / rawCandidateCount : 0,
    lowConfidenceCount,
    lowConfidenceRate: candidateCount > 0 ? lowConfidenceCount / candidateCount : 0,
    topRules,
    errors,
  };
}
