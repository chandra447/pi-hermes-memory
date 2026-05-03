import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { DatabaseManager } from '../store/db.js';
import { searchSessions, getIndexedMessageCount } from '../store/session-search.js';

interface SearchResult {
  success: boolean;
  count?: number;
  message?: string;
  output?: string;
}

export function registerSessionSearchTool(pi: ExtensionAPI, dbManager: DatabaseManager): void {
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
