import * as path from 'node:path';
import * as os from 'node:os';
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { DatabaseManager } from '../store/db.js';
import { searchSessions, getIndexedMessageCount } from '../store/session-search.js';
import { searchSessionAnchors } from '../store/session-anchor-search.js';
import type { SessionAnchorRange, SessionAnchorSearchResult } from '../store/session-anchor-search.js';
import type { SessionSearchConfig } from '../types.js';

interface SearchResult {
  success: boolean;
  count?: number;
  message?: string;
  output?: string;
  ranges?: SessionAnchorRange[];
}

interface SessionSearchToolOptions {
  sessionsDir?: string;
}

const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), '.pi', 'agent', 'sessions');

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

Returns conversation snippets with session dates and project context.`,
    promptSnippet: 'Search past conversations for relevant context',
    promptGuidelines: [
      'Use session_search when the user asks about previous discussions or past work.',
      'Use session_search when you need context from earlier sessions.',
    ],
    parameters: Type.Object({
      query: Type.String({ description: 'Search query. Use natural language or specific terms.' }),
      project: Type.Optional(Type.String({ description: 'Filter by project name (optional).' })),
      role: Type.Optional(StringEnum(['user', 'assistant'] as const, { description: 'Filter by message role (optional).' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum results to return (default: 10, max: 20).' })),
    }),
    execute: async (_id: string, args: { query: string; project?: string; role?: string; limit?: number }) => {
      const query = args.query;
      const project = args.project;
      const role = args.role;
      const limit = Math.min(args.limit || 10, 20);

      if (!query || query.trim().length === 0) {
        const result: SearchResult = { success: false, message: 'query is required' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const totalMessages = getIndexedMessageCount(dbManager);
      if (totalMessages === 0) {
        const result: SearchResult = { success: false, message: 'No sessions indexed yet. Run /memory-index-sessions to import past sessions.' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const results = searchSessions(dbManager, query, { project, role, limit });

      if (results.length === 0) {
        const result: SearchResult = { success: true, count: 0, message: `No results found for "${query}". Try a different search term or broader query.` };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      let output = `Found ${results.length} results for "${query}":\n\n`;

      for (const r of results) {
        const date = new Date(r.timestamp).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        });

        output += `---\n`;
        output += `📅 ${date} | 📁 ${r.project} | ${r.role === 'user' ? '👤 User' : '🤖 Assistant'}\n`;
        output += `${r.snippet}\n\n`;
      }

      const finalResult: SearchResult = { success: true, count: results.length, output: output.trim() };
      return { content: [{ type: 'text' as const, text: output.trim() }], details: finalResult };
    },
  });
}
