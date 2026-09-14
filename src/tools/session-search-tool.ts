import * as path from 'node:path';
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { DatabaseManager } from '../store/db.js';
import { searchSessions, getIndexedMessageCount } from '../store/session-search.js';
import { collectNaturalLanguageTerms } from '../store/fts-query.js';
import { searchSessionAnchors } from '../store/session-anchor-search.js';
import type { SessionAnchorRange, SessionAnchorSearchResult } from '../store/session-anchor-search.js';
import type { SessionSearchConfig } from '../types.js';
import { AGENT_ROOT } from '../paths.js';
import { createSharedToolResultRenderer } from './shared-output-view.js';
import { searchResultView } from './tool-result-views.js';

interface SearchResult {
  success: boolean;
  count?: number;
  message?: string;
  output?: string;
  outputChars?: number;
  outputTruncated?: boolean;
  snippetChars?: number;
  truncatedCount?: number;
  ranges?: SessionAnchorRange[];
}

interface SessionSearchToolOptions {
  sessionsDir?: string;
}

const DEFAULT_SESSIONS_DIR = path.join(AGENT_ROOT, 'sessions');
const DEFAULT_LEGACY_SNIPPET_CHARS = 1_200;
const MAX_LEGACY_SNIPPET_CHARS = 4_000;
const MAX_LEGACY_OUTPUT_CHARS = 50 * 1024;
// Context kept ahead of the anchor hit when a snippet is windowed. Kept next
// to the other legacy truncation caps so the truncation family lives in one
// place (snippetChars above, the indexer's 100 KB content cap in
// session-indexer.ts, getMessageText's 500 in types.ts).
const LEGACY_SNIPPET_LEAD_CHARS = 200;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Truncate a long legacy snippet to maxChars by windowing around the first
 * hit of the effective search terms (the same stop-word-filtered term set the
 * FTS5 path matched on) instead of a blunt head-slice, so the caller sees the
 * matched region of a multi-MB row, not its preamble. When no anchor term
 * matches the body — an all-stop-word query, or a row the LIKE fallback
 * matched on raw terms — the window falls back to the head, the previous
 * behavior, and the truncation note still reports the true total length.
 */
function truncateLegacySnippet(
  text: string,
  maxChars: number,
  anchorTerms: string[],
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };

  // One lowercase pass for the whole body, not one per term: on the multi-MB
  // legacy rows this truncation exists for, per-term lowercasing multiplied
  // the full-body scan by the term count.
  const lowerText = text.toLowerCase();
  let hit = -1;
  for (const term of anchorTerms) {
    const i = lowerText.indexOf(term.toLowerCase());
    if (i !== -1 && (hit === -1 || i < hit)) hit = i;
  }

  let start = hit === -1 ? 0 : Math.max(0, hit - LEGACY_SNIPPET_LEAD_CHARS);
  let end = Math.min(text.length, start + maxChars);

  // UTF-16 units, not code points: a window edge landing between the halves
  // of a surrogate pair would render one corrupted character, so nudge such
  // edges by one unit.
  if (start > 0 && isHighSurrogate(text.charCodeAt(start - 1)) && isLowSurrogate(text.charCodeAt(start))) {
    start += 1;
  }
  if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
    end -= 1;
  }

  const suffix = `\n... (truncated, ${text.length} chars total — refine the query or increase snippetChars)`;
  const prefix = start > 0 ? '… ' : '';
  return {
    text: `${prefix}${text.slice(start, end)}${suffix}`,
    truncated: true,
  };
}

function capLegacyOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_LEGACY_OUTPUT_CHARS) return { text, truncated: false };
  const suffix = `\n... (output truncated, ${text.length} chars total — refine the query or lower the result limit)`;
  return {
    text: `${text.slice(0, MAX_LEGACY_OUTPUT_CHARS - suffix.length)}${suffix}`,
    truncated: true,
  };
}

export function registerSessionSearchTool(
  pi: ExtensionAPI,
  dbManager: DatabaseManager,
  sessionSearchConfig: SessionSearchConfig = { variant: 'legacy' },
  options: SessionSearchToolOptions = {},
): void {
  if (sessionSearchConfig.variant === 'anchors') {
    registerAnchorSessionSearchTool(pi, options.sessionsDir ?? DEFAULT_SESSIONS_DIR);
    return;
  }

  registerLegacySessionSearchTool(pi, dbManager);
}

function registerAnchorSessionSearchTool(pi: ExtensionAPI, sessionsDir: string): void {
  pi.registerTool({
    name: 'session_search',
    label: 'Session Search',
    description: `Search Pi session JSONL files in the opt-in anchor mode using a Markdown request.

This mode accepts only a markdown request. Supported scalar fields are from, to, cwd, and limit. Supported list sections are all, any, and exclude: all terms must match, any requires at least one listed term, and exclude removes matching ranges. It returns compact JSONL line-range anchors, not summaries or previews. Output is plain text: count, optional message, then anchors as path:startLine-endLine with a short reason.

Example:
from: 2026-05-14
to: 2026-05-15
cwd: /path/to/project
limit: 20

all:
- alpha

any:
- beta
- gamma

exclude:
- delta`,
    promptSnippet: 'Search past session JSONL files for compact source anchors',
    promptGuidelines: [
      'Use session_search with markdown only when the session search anchor mode is configured.',
      'Request source anchors, not summaries or previews.',
      'Use all for required terms, any for alternatives, and exclude for terms that must not appear in a returned range.',
    ],
    renderResult: createSharedToolResultRenderer(searchResultView),
    parameters: Type.Object({
      markdown: Type.String({ description: 'Markdown request with optional from/to/cwd/limit fields and all/any/exclude lists.' }),
    }),
    execute: async (_id: string, args: { markdown: string }) => {
      const markdown = args.markdown;

      if (!markdown || markdown.trim().length === 0) {
        const result: SearchResult = { success: false, message: 'markdown is required' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const searchResult = searchSessionAnchors(markdown, { sessionsDir });
      if (!searchResult.success) {
        const result: SearchResult = { success: false, message: searchResult.message ?? 'Anchor session search failed.' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const output = formatAnchorSearchOutput(searchResult);
      const result: SearchResult = {
        success: true,
        count: searchResult.ranges.length,
        message: searchResult.message,
        output,
        ranges: searchResult.ranges,
      };
      return { content: [{ type: 'text' as const, text: output }], details: result };
    },
  });
}

function formatAnchorSearchOutput(searchResult: SessionAnchorSearchResult): string {
  const lines = [`count: ${searchResult.ranges.length}`];
  if (searchResult.message) lines.push(`message: ${searchResult.message}`);
  if (searchResult.ranges.length > 0) {
    lines.push("anchors:");
    for (const range of searchResult.ranges) {
      const anchor = `${range.path}:${range.startLine}-${range.endLine}`;
      const reason = compactReason(range.reason);
      lines.push(reason ? `- ${anchor} — ${reason}` : `- ${anchor}`);
    }
  }
  return lines.join("\n");
}

function compactReason(reason: string | undefined): string {
  if (!reason) return "";
  const oneLine = reason.replace(/\s+/g, " ").trim();
  return oneLine.length <= 180 ? oneLine : `${oneLine.slice(0, 177)}...`;
}

function registerLegacySessionSearchTool(pi: ExtensionAPI, dbManager: DatabaseManager): void {
  pi.registerTool({
    name: 'session_search',
    label: 'Session Search',
    description: `Search across past Pi coding sessions for relevant conversation context. Use this when the user asks about previous discussions, past work, or when you need context from earlier sessions.

Examples:
- "What did we discuss about auth last week?"
- "Find the PR where we fixed the test hang"
- "What approach did we take for the database migration?"

Returns bounded conversation snippets with session dates and project context. Long messages are truncated to a window around the first query-term hit, with their original character count.`,
    promptSnippet: 'Search past conversations for relevant context',
    promptGuidelines: [
      'Use session_search when the user asks about previous discussions or past work.',
      'Use session_search when you need context from earlier sessions.',
    ],
    renderResult: createSharedToolResultRenderer(searchResultView),
    parameters: Type.Object({
      query: Type.String({ description: 'Search query. Use natural language or specific terms.' }),
      project: Type.Optional(Type.String({ description: 'Filter by project name (optional).' })),
      role: Type.Optional(StringEnum(['user', 'assistant'] as const, { description: 'Filter by message role (optional).' })),
      limit: Type.Optional(Type.Number({
        description: 'Maximum results to return (default: 10, min: 1, max: 20).',
        minimum: 1,
        maximum: 20,
      })),
      snippetChars: Type.Optional(Type.Number({
        description: `Maximum characters per result snippet (default: ${DEFAULT_LEGACY_SNIPPET_CHARS}, max: ${MAX_LEGACY_SNIPPET_CHARS}).`,
        minimum: 100,
        maximum: MAX_LEGACY_SNIPPET_CHARS,
      })),
    }),
    execute: async (_id: string, args: { query: string; project?: string; role?: string; limit?: number; snippetChars?: number }) => {
      const query = args.query;
      const project = args.project;
      const role = args.role;
      const requestedLimit = Number.isFinite(args.limit) ? Math.floor(args.limit!) : 10;
      const limit = Math.min(Math.max(requestedLimit, 1), 20);
      const requestedSnippetChars = Number.isFinite(args.snippetChars)
        ? Math.floor(args.snippetChars!)
        : DEFAULT_LEGACY_SNIPPET_CHARS;
      const snippetChars = Math.min(Math.max(requestedSnippetChars, 100), MAX_LEGACY_SNIPPET_CHARS);

      if (!query || query.trim().length === 0) {
        const result: SearchResult = { success: false, message: 'query is required' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const totalMessages = getIndexedMessageCount(dbManager);
      if (totalMessages === 0) {
        const result: SearchResult = { success: false, message: 'No sessions indexed yet. Run /memory-index-sessions to import past sessions.' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      // The window anchor is the effective term set of the query — quoted
      // phrases kept, connectors and #184 stop words dropped — the same set
      // normalizeFts5Query builds the FTS5 match from. Anchoring on raw
      // tokens would let a stop word near the head of a long body pin the
      // window at the start, exactly what windowing exists to avoid.
      const anchorTerms = collectNaturalLanguageTerms(query);
      const results = searchSessions(dbManager, query, { project, role, limit });

      if (results.length === 0) {
        const output = capLegacyOutput('No results found. Try a different search term or broader query.');
        const result: SearchResult = {
          success: true,
          count: 0,
          message: output.text,
          outputChars: output.text.length,
          outputTruncated: output.truncated,
        };
        return { content: [{ type: 'text' as const, text: output.text }], details: result };
      }

      const blocks: string[] = [`Found ${results.length} results for "${query}":`];
      let truncatedCount = 0;

      for (const r of results) {
        const date = new Date(r.timestamp).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        });

        const snippet = truncateLegacySnippet(r.snippet, snippetChars, anchorTerms);
        if (snippet.truncated) truncatedCount += 1;
        blocks.push([
          '---',
          `📅 ${date} | 📁 ${r.project} | ${r.role === 'user' ? '👤 User' : '🤖 Assistant'}`,
          snippet.text,
        ].join('\n'));
      }

      const output = capLegacyOutput(blocks.join('\n\n').trim());
      const finalResult: SearchResult = {
        success: true,
        count: results.length,
        truncatedCount,
        snippetChars,
        outputChars: output.text.length,
        outputTruncated: output.truncated,
      };
      return { content: [{ type: 'text' as const, text: output.text }], details: finalResult };
    },
  });
}
