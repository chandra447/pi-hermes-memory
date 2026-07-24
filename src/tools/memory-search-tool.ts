import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { DatabaseManager } from '../store/db.js';
import { searchMemories, getMemoryStats } from '../store/sqlite-memory-store.js';
import type { MemoryCategory } from '../types.js';

interface SearchResult {
  success: boolean;
  count?: number;
  message?: string;
  output?: string;
}

export function registerMemorySearchTool(pi: ExtensionAPI, dbManager: DatabaseManager): void {
  pi.registerTool({
    name: 'memory_search',
    label: 'Memory Search',
    description: `Search extended memory store for relevant entries. Use this when you need context beyond what's in the system prompt — the extended store has unlimited capacity and is searchable.

Use cases:
- Find memories about a specific topic: "What do I know about auth setup?"
- Search project-specific memories: "What conventions does project X follow?"
- Find user preferences: "What are the user's testing preferences?"
- Search for past failures: "memory_search('auth', category='failure')"

Set action="stats" to inspect store state (total entries, breakdowns by target/category, oldest/newest) without writing anything.

Returns matching memory entries with project context and dates.`,
    promptSnippet: 'Search extended memory store (unlimited capacity); action="stats" for introspection',
    promptGuidelines: [
      'Use memory_search when you need context beyond what is in the system prompt.',
      'Use memory_search to find project-specific memories or user preferences.',
      'Use memory_search with category filter to find specific types of memories (failure, correction, insight, etc.).',
      'Use memory_search with action="stats" to read total counts, by-target/by-category breakdowns, and date range without writing.',
    ],
    parameters: Type.Object({
      action: Type.Optional(
        StringEnum(['search', 'stats'] as const, {
          description: 'Operation: "search" (default) returns matching entries; "stats" returns store introspection (counts, breakdowns, oldest/newest).',
        })
      ),
      query: Type.Optional(
        Type.String({
          description: 'Search query. Required for action="search"; ignored for action="stats".',
        })
      ),
      project: Type.Optional(Type.String({ description: 'Filter by project name. Pass null for global memories only. Ignored for action="stats".' })),
      target: Type.Optional(StringEnum(['memory', 'user', 'failure'] as const, { description: 'Filter by target type (memory, user, or failure). Ignored for action="stats".' })),
      category: Type.Optional(StringEnum(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk'] as const, { description: 'Filter by memory category. Ignored for action="stats".' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum results to return (default: 10, max: 20). Ignored for action="stats".' })),
    }),
    execute: async (_id: string, args: { action?: 'search' | 'stats'; query?: string; project?: string; target?: string; category?: string; limit?: number }) => {
      const action: 'search' | 'stats' = args.action === 'stats' ? 'stats' : 'search';

      if (action === 'stats') {
        const stats = getMemoryStats(dbManager);
        const lines: string[] = [];
        lines.push(`Memory store stats — ${stats.total} entries total`);
        lines.push('');

        if (stats.byTarget.length > 0) {
          lines.push('By target:');
          for (const row of stats.byTarget) {
            lines.push(`  ${row.target}: ${row.count}`);
          }
          lines.push('');
        }

        if (stats.byCategory.length > 0) {
          lines.push('By category:');
          for (const row of stats.byCategory) {
            lines.push(`  ${row.category ?? '(uncategorized)'}: ${row.count}`);
          }
          lines.push('');
        }

        if (stats.byProject.length > 0) {
          lines.push('By project:');
          for (const row of stats.byProject) {
            lines.push(`  ${row.project ?? '(global)'}: ${row.count}`);
          }
          lines.push('');
        }

        lines.push(`Date range: ${stats.oldest ?? '—'} → ${stats.newest ?? '—'}`);

        const text = lines.join('\n').trimEnd();
        const finalResult: SearchResult = { success: true, count: stats.total, output: text, message: text };
        return { content: [{ type: 'text' as const, text }], details: { ...finalResult, stats } };
      }

      const query = args.query ?? '';
      const project = args.project;
      const target = args.target;
      const category = args.category as MemoryCategory | undefined;
      const limit = Math.min(args.limit || 10, 20);

      if (!query || query.trim().length === 0) {
        const result: SearchResult = { success: false, message: 'query is required for action="search"' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const stats = getMemoryStats(dbManager);
      if (stats.total === 0) {
        const result: SearchResult = { success: false, message: 'No memories in extended store yet. Use the memory tool with add action to store memories.' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const results = searchMemories(dbManager, query, { project, target, category, limit });

      if (results.length === 0) {
        const result: SearchResult = { success: true, count: 0, message: `No memories found matching "${query}". Try a different search term or broader query.` };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      let output = `Found ${results.length} memories matching "${query}":\n\n`;

      for (const entry of results) {
        const projectLabel = entry.project ? `[${entry.project}]` : '[global]';
        const targetLabel = entry.target === 'user' ? '👤' : entry.target === 'failure' ? '⚠️' : '🧠';
        const categoryLabel = entry.category ? ` [${entry.category}]` : '';
        output += `${targetLabel} ${projectLabel}${categoryLabel} ${entry.content}\n`;
        output += `   Created: ${entry.created} | Last used: ${entry.lastReferenced}\n\n`;
      }

      const finalResult: SearchResult = { success: true, count: results.length, output: output.trim() };
      return { content: [{ type: 'text' as const, text: output.trim() }], details: finalResult };
    },
  });
}
