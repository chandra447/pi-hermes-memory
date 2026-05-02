import { DatabaseManager } from '../store/db.js';
import { searchMemories, getMemoryStats } from '../store/sqlite-memory-store.js';

export function registerMemorySearchTool(ctx: {
  registerTool: (tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    handler: (args: Record<string, unknown>) => Promise<string>;
  }) => void;
}, dbManager: DatabaseManager) {
  ctx.registerTool({
    name: 'memory_search',
    description: `Search extended memory store for relevant entries. Use this when you need context beyond what's in the system prompt — the extended store has unlimited capacity and is searchable.

Use cases:
- Find memories about a specific topic: "What do I know about auth setup?"
- Search project-specific memories: "What conventions does project X follow?"
- Find user preferences: "What are the user's testing preferences?"

Returns matching memory entries with project context and dates.`,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query. Use natural language or specific terms.',
        },
        project: {
          type: 'string',
          description: 'Filter by project name. Pass null for global memories only.',
        },
        target: {
          type: 'string',
          enum: ['memory', 'user'],
          description: 'Filter by target type (memory or user).',
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
      const target = args.target as string | undefined;
      const limit = Math.min((args.limit as number) || 10, 20);

      if (!query || query.trim().length === 0) {
        return 'Error: query is required';
      }

      const stats = getMemoryStats(dbManager);
      if (stats.total === 0) {
        return 'No memories in extended store yet. Use the memory tool with add action to store memories.';
      }

      const results = searchMemories(dbManager, query, { project, target, limit });

      if (results.length === 0) {
        return `No memories found matching "${query}". Try a different search term or broader query.`;
      }

      let output = `Found ${results.length} memories matching "${query}":\n\n`;

      for (const entry of results) {
        const projectLabel = entry.project ? `[${entry.project}]` : '[global]';
        const targetLabel = entry.target === 'user' ? '👤' : '🧠';
        output += `${targetLabel} ${projectLabel} ${entry.content}\n`;
        output += `   Created: ${entry.created} | Last used: ${entry.lastReferenced}\n\n`;
      }

      return output.trim();
    },
  });
}
