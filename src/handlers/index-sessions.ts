import path from 'node:path';
import os from 'node:os';
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DatabaseManager } from '../store/db.js';
import { indexAllSessions, getSessionStats } from '../store/session-indexer.js';

const SESSIONS_DIR = path.join(os.homedir(), '.pi', 'agent', 'sessions');

export function registerIndexSessionsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("memory-index-sessions", {
    description: "Import past Pi sessions into the search database",
    handler: async (_args, ctx) => {
      const sendUserMessage = (msg: string) => {
        if (ctx && typeof ctx === 'object' && 'sendUserMessage' in ctx) {
          (ctx as { sendUserMessage: (msg: string) => void }).sendUserMessage(msg);
        }
      };

      sendUserMessage('🔍 Indexing session history...');

      try {
        const memoryDir = path.join(os.homedir(), '.pi', 'agent', 'memory');
        const dbManager = new DatabaseManager(memoryDir);

        try {
          const result = indexAllSessions(dbManager, SESSIONS_DIR);
          const stats = getSessionStats(dbManager);

          let output = `\n✅ Session indexing complete!\n\n`;
          output += `📊 Results:\n`;
          output += `• Sessions processed: ${result.sessionsProcessed}\n`;
          output += `• Sessions indexed: ${result.sessionsIndexed}\n`;
          output += `• Sessions skipped (already indexed): ${result.sessionsSkipped}\n`;
          output += `• Messages indexed: ${result.messagesIndexed}\n`;

          if (stats.projects.length > 0) {
            output += `\n📁 Projects:\n`;
            for (const p of stats.projects) {
              output += `• ${p.project}: ${p.sessions} sessions, ${p.messages} messages\n`;
            }
          }

          if (result.errors.length > 0) {
            output += `\n⚠️ Errors (${result.errors.length}):\n`;
            for (const err of result.errors.slice(0, 5)) {
              output += `• ${err}\n`;
            }
            if (result.errors.length > 5) {
              output += `• ... and ${result.errors.length - 5} more\n`;
            }
          }

          output += `\n💡 Use the \`session_search\` tool to search across indexed sessions.`;

          sendUserMessage(output);
        } finally {
          dbManager.close();
        }
      } catch (err) {
        sendUserMessage(`❌ Session indexing failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}
