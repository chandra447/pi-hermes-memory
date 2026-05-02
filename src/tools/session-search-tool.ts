import { DatabaseManager } from '../store/db.js';
import { searchSessions, getIndexedMessageCount } from '../store/session-search.js';

export function registerSessionSearchTool(ctx: {
  registerTool: (tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    handler: (args: Record<string, unknown>) => Promise<string>;
  }) => void;
}, dbManager: DatabaseManager) {
  ctx.registerTool({
    name: 'session_search',
    description: `Search across past Pi coding sessions for relevant conversation context. Use this when the user asks about previous discussions, past work, or when you need context from earlier sessions.

Examples:
- "What did we discuss about auth last week?"
- "Find the PR where we fixed the test hang"
- "What approach did we take for the database migration?"

Returns conversation snippets with session dates and project context.`,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query. Use natural language or specific terms.',
        },
        project: {
          type: 'string',
          description: 'Filter by project name (optional).',
        },
        role: {
          type: 'string',
          enum: ['user', 'assistant'],
          description: 'Filter by message role (optional).',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default: 10, max: 20).',
        },
      },
      required: ['query'],
    },
    handler: async (args: Record<string, unknown>) => {
      const query = args.query as string;
      const project = args.project as string | undefined;
      const role = args.role as string | undefined;
      const limit = Math.min((args.limit as number) || 10, 20);

      if (!query || query.trim().length === 0) {
        return 'Error: query is required';
      }

      const totalMessages = getIndexedMessageCount(dbManager);
      if (totalMessages === 0) {
        return 'No sessions indexed yet. Run /memory-index-sessions to import past sessions.';
      }

      const results = searchSessions(dbManager, query, { project, role, limit });

      if (results.length === 0) {
        return `No results found for "${query}". Try a different search term or broader query.`;
      }

      let output = `Found ${results.length} results for "${query}":\n\n`;

      for (const result of results) {
        const date = new Date(result.timestamp).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        });

        output += `---\n`;
        output += `📅 ${date} | 📁 ${result.project} | ${result.role === 'user' ? '👤 User' : '🤖 Assistant'}\n`;
        output += `${result.snippet}\n\n`;
      }

      return output.trim();
    },
  });
}
