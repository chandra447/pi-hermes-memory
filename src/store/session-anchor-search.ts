import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_LINES = 500000;
const LIST_FIELDS = new Set(["all", "any", "exclude"]);
const VALUE_FIELDS = new Set(["from", "to", "cwd", "limit"]);

export interface SessionAnchorRange {
  path: string;
  startLine: number;
  endLine: number;
  sessionId?: string;
  cwd?: string;
  startTime?: string;
  endTime?: string;
  score?: number;
  reason: string;
}

export interface SessionAnchorSearchResult {
  success: boolean;
  ranges: SessionAnchorRange[];
  message?: string;
}

export interface SessionAnchorSearchOptions {
  sessionsDir?: string;
  maxFiles?: number;
  maxLines?: number;
}

interface ParsedAnchorRequest {
  from?: Date;
  to?: Date;
  cwd?: string;
  limit: number;
  all: string[];
  any: string[];
  exclude: string[];
  hasTimeConstraint: boolean;
  hasTextConstraint: boolean;
}

interface LineHit {
  path: string;
  lineNumber: number;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  timestampMs?: number;
  text: string;
  score: number;
  reason: string;
}

interface PendingRange {
  path: string;
  startLine: number;
  endLine: number;
  sessionId?: string;
  cwd?: string;
  startTime?: string;
  endTime?: string;
  score: number;
  reason: string;
  text: string;
}

export function searchSessionAnchors(
  markdown: string,
  options: SessionAnchorSearchOptions = {},
): SessionAnchorSearchResult {
  const parsed = parseMarkdownRequest(markdown);
  if (!parsed.success) {
    return { success: false, ranges: [], message: parsed.message };
  }

  if (!options.sessionsDir) {
    return { success: false, ranges: [], message: "sessionsDir is required" };
  }

  if (!fs.existsSync(options.sessionsDir)) {
    return { success: false, ranges: [], message: `sessionsDir does not exist: ${options.sessionsDir}` };
  }

  const files = findJsonlFiles(options.sessionsDir).sort();
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  if (files.length > maxFiles) {
    return {
      success: false,
      ranges: [],
      message: `Request too broad: ${files.length} session files exceed the configured scan cap of ${maxFiles}. Add from/to, cwd, all, or any constraints.`,
    };
  }

  const ranges: PendingRange[] = [];
  let scannedLines = 0;

  for (const file of files) {
    const remainingLines = maxLines - scannedLines;
    const fileResult = searchJsonlFile(file, parsed.request, remainingLines, scannedLines, maxLines);
    if (!fileResult.success) {
      return { success: false, ranges: [], message: fileResult.message };
    }
    scannedLines += fileResult.scannedLines;
    ranges.push(...fileResult.ranges);
  }

  const filtered = ranges.filter((range) => !containsAny(range.text, parsed.request.exclude));
  const sorted = sortRanges(filtered, parsed.request.hasTextConstraint);
  const limited = sorted.slice(0, parsed.request.limit).map(({ text: _text, ...range }) => range);

  return {
    success: true,
    ranges: limited,
    message: limited.length === 0 ? "No matching session anchors found." : undefined,
  };
}

function parseMarkdownRequest(markdown: string): { success: true; request: ParsedAnchorRequest } | { success: false; message: string } {
  if (!markdown || markdown.trim().length === 0) {
    return { success: false, message: "markdown is required" };
  }

  const fields = new Map<string, string>();
  const lists: Record<"all" | "any" | "exclude", string[]> = { all: [], any: [], exclude: [] };
  const seen = new Set<string>();
  let currentList: "all" | "any" | "exclude" | null = null;

  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const fieldMatch = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(trimmed);
    if (fieldMatch) {
      const field = fieldMatch[1];
      const value = fieldMatch[2];

      if (!VALUE_FIELDS.has(field) && !LIST_FIELDS.has(field)) {
        return {
          success: false,
          message: `Invalid field '${field}'. Supported fields: from, to, cwd, limit, all, any, exclude.`,
        };
      }
      if (seen.has(field)) {
        return { success: false, message: `Duplicate field '${field}'. Keep one value.` };
      }
      seen.add(field);

      if (LIST_FIELDS.has(field)) {
        if (value.trim().length > 0) {
          return { success: false, message: `Invalid list section '${field}'. Use '${field}:' followed by '- item' lines.` };
        }
        currentList = field as "all" | "any" | "exclude";
      } else {
        fields.set(field, value.trim());
        currentList = null;
      }
      continue;
    }

    const listMatch = /^-\s+(.*)$/.exec(trimmed);
    if (listMatch && currentList) {
      const term = listMatch[1].trim();
      if (term.length === 0) {
        return { success: false, message: `Empty term in '${currentList}'. Remove it or provide text.` };
      }
      lists[currentList].push(term);
      continue;
    }

    if (listMatch && !currentList) {
      return { success: false, message: "List item found outside all, any, or exclude section." };
    }

    return { success: false, message: `Invalid markdown line: ${trimmed}` };
  }

  const limitValue = fields.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitValue !== undefined) {
    if (!/^\d+$/.test(limitValue)) {
      return { success: false, message: "Invalid limit. Use a positive integer." };
    }
    const parsedLimit = Number(limitValue);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit <= 0) {
      return { success: false, message: "Invalid limit. Use a positive integer." };
    }
    limit = Math.min(parsedLimit, MAX_LIMIT);
  }

  const fromValue = fields.get("from");
  const toValue = fields.get("to");
  const from = fromValue === undefined ? undefined : parseDateTime(fromValue, "from");
  if (from === null) return { success: false, message: "Invalid from. Use YYYY-MM-DD or an ISO timestamp." };
  const to = toValue === undefined ? undefined : parseDateTime(toValue, "to");
  if (to === null) return { success: false, message: "Invalid to. Use YYYY-MM-DD or an ISO timestamp." };
  if (from && to && from.getTime() > to.getTime()) {
    return { success: false, message: "Invalid time window. 'from' must be before or equal to 'to'." };
  }

  const cwd = fields.get("cwd");
  if (fields.has("cwd") && (!cwd || cwd.trim().length === 0)) {
    return { success: false, message: "Invalid cwd. Provide a non-empty path." };
  }
  const all = lists.all;
  const any = lists.any;
  const exclude = lists.exclude;
  const hasTimeConstraint = Boolean(from || to);
  const hasCwdConstraint = Boolean(cwd);
  const hasTextConstraint = all.length > 0 || any.length > 0;

  if (!hasTimeConstraint && !hasCwdConstraint && !hasTextConstraint) {
    return {
      success: false,
      message: "Request needs at least one constraint: provide from/to, cwd, all, or any.",
    };
  }
  return {
    success: true,
    request: { from, to, cwd, limit, all, any, exclude, hasTimeConstraint, hasTextConstraint },
  };
}

function parseDateTime(value: string, boundary: "from" | "to"): Date | null {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const date = boundary === "from"
      ? new Date(year, month - 1, day, 0, 0, 0, 0)
      : new Date(year, month - 1, day, 23, 59, 59, 999);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    return date;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function findJsonlFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }

  return files;
}

function searchJsonlFile(
  filePath: string,
  request: ParsedAnchorRequest,
  maxLines: number,
  scannedBefore: number,
  scanCap: number,
): { success: true; ranges: PendingRange[]; scannedLines: number } | { success: false; message: string } {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split(/\r?\n/);
  const hits: LineHit[] = [];
  let currentSessionId: string | undefined;
  let currentCwd: string | undefined;

  let scannedLines = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;

    scannedLines += 1;
    if (scannedLines > maxLines) {
      return {
        success: false,
        message: `Request too broad: scanned ${scannedBefore + scannedLines} session lines, exceeding the configured scan cap of ${scanCap}. Add from/to, cwd, all, or any constraints.`,
      };
    }

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return { success: false, message: `Invalid JSON in ${filePath}:${index + 1}` };
    }

    const sessionId = getSessionId(event) ?? currentSessionId;
    if (sessionId) currentSessionId = sessionId;

    const cwd = getCwd(event) ?? currentCwd;
    if (cwd) currentCwd = cwd;

    if (request.cwd && cwd !== request.cwd) continue;

    const timestamp = getTimestamp(event);
    const timestampMs = timestamp ? Date.parse(timestamp) : undefined;
    const hasValidTimestamp = timestampMs !== undefined && !Number.isNaN(timestampMs);
    if (request.hasTimeConstraint) {
      if (!hasValidTimestamp) continue;
      if (request.from && timestampMs < request.from.getTime()) continue;
      if (request.to && timestampMs > request.to.getTime()) continue;
    }

    const text = textualizeEvent(event);
    const termScore = scoreTerms(text, request);
    const matchesTerms = request.hasTextConstraint ? termScore > 0 : true;
    if (!matchesTerms) continue;

    if (!request.hasTextConstraint && !hasValidTimestamp) continue;

    hits.push({
      path: filePath,
      lineNumber: index + 1,
      sessionId,
      cwd,
      timestamp: hasValidTimestamp ? timestamp : undefined,
      timestampMs: hasValidTimestamp ? timestampMs : undefined,
      text,
      score: request.hasTextConstraint ? termScore : 1,
      reason: buildReason(request, text),
    });
  }

  return { success: true, ranges: mergeAdjacentHits(hits), scannedLines };
}

function mergeAdjacentHits(hits: LineHit[]): PendingRange[] {
  const ranges: PendingRange[] = [];

  for (const hit of hits) {
    const last = ranges.at(-1);
    if (last && last.path === hit.path && last.endLine + 1 === hit.lineNumber && last.reason === hit.reason) {
      last.endLine = hit.lineNumber;
      last.score += hit.score;
      last.text += "\n" + hit.text;
      last.sessionId ??= hit.sessionId;
      last.cwd ??= hit.cwd;
      if (!last.startTime && hit.timestamp) last.startTime = hit.timestamp;
      if (hit.timestamp) last.endTime = hit.timestamp;
      continue;
    }

    ranges.push({
      path: hit.path,
      startLine: hit.lineNumber,
      endLine: hit.lineNumber,
      sessionId: hit.sessionId,
      cwd: hit.cwd,
      startTime: hit.timestamp,
      endTime: hit.timestamp,
      score: hit.score,
      reason: hit.reason,
      text: hit.text,
    });
  }

  return ranges;
}

function sortRanges(ranges: PendingRange[], textConstrained: boolean): PendingRange[] {
  return [...ranges].sort((a, b) => {
    if (textConstrained && b.score !== a.score) return b.score - a.score;
    const timeCompare = Date.parse(a.startTime ?? "") - Date.parse(b.startTime ?? "");
    if (!Number.isNaN(timeCompare) && timeCompare !== 0) return timeCompare;
    const pathCompare = a.path.localeCompare(b.path);
    if (pathCompare !== 0) return pathCompare;
    return a.startLine - b.startLine;
  });
}

function scoreTerms(text: string, request: ParsedAnchorRequest): number {
  const lower = text.toLocaleLowerCase();
  const matchedAll = request.all.filter((term) => lower.includes(term.toLocaleLowerCase()));
  const matchedAny = request.any.filter((term) => lower.includes(term.toLocaleLowerCase()));

  if (request.all.length > 0 && matchedAll.length !== request.all.length) return 0;
  if (request.any.length > 0 && matchedAny.length === 0) return 0;

  if (request.all.length === 0 && request.any.length === 0) return 1;
  return matchedAll.length * 2 + matchedAny.length;
}

function buildReason(request: ParsedAnchorRequest, text: string): string {
  if (!request.hasTextConstraint) {
    if (request.hasTimeConstraint && request.cwd) return "cwd+time window";
    if (request.hasTimeConstraint) return "time window";
    return "cwd";
  }

  const lower = text.toLocaleLowerCase();
  const parts: string[] = [];
  if (request.all.length > 0) parts.push(`matched all: ${request.all.join(", ")}`);
  const matchedAny = request.any.filter((term) => lower.includes(term.toLocaleLowerCase()));
  if (matchedAny.length > 0) parts.push(`matched any: ${matchedAny.join(", ")}`);
  return parts.join("; ");
}

function containsAny(text: string, terms: string[]): boolean {
  const lower = text.toLocaleLowerCase();
  return terms.some((term) => lower.includes(term.toLocaleLowerCase()));
}

function getTimestamp(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  if (typeof event.timestamp === "string") return event.timestamp;
  if (isRecord(event.message) && typeof event.message.timestamp === "string") return event.message.timestamp;
  return undefined;
}

function getSessionId(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  if (typeof event.sessionId === "string") return event.sessionId;
  if (typeof event.session_id === "string") return event.session_id;
  if (event.type === "session" && typeof event.id === "string") return event.id;
  if (isRecord(event.session) && typeof event.session.id === "string") return event.session.id;
  return undefined;
}

function getCwd(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  if (typeof event.cwd === "string") return event.cwd;
  if (isRecord(event.session) && typeof event.session.cwd === "string") return event.session.cwd;
  return undefined;
}

function textualizeEvent(event: unknown): string {
  const parts: string[] = [];
  collectStrings(event, parts);
  return parts.join("\n");
}

const METADATA_TEXT_KEYS = new Set([
  "type",
  "id",
  "parentId",
  "sessionId",
  "session_id",
  "timestamp",
  "cwd",
  "role",
  "customType",
]);

function collectStrings(value: unknown, parts: string[], key?: string): void {
  if (typeof value === "string") {
    if (!key || !METADATA_TEXT_KEYS.has(key)) parts.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, parts, key);
    return;
  }

  if (!isRecord(value)) return;
  for (const [childKey, item] of Object.entries(value)) collectStrings(item, parts, childKey);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
