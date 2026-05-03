/**
 * Index sessions command — /memory-index-sessions imports past sessions into SQLite.
 */

import path from 'node:path';
import fs from 'node:fs';
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

      // Show initial progress
      sendUserMessage('🔍 Scanning session directories...');

      try {
        // Count sessions first for progress display
        let totalFiles = 0;
        let projectDirs: string[] = [];
        if (fs.existsSync(SESSIONS_DIR)) {
          projectDirs = fs.readdirSync(SESSIONS_DIR)
            .filter(d => fs.statSync(path.join(SESSIONS_DIR, d)).isDirectory());
          for (const dir of projectDirs) {
            const files = fs.readdirSync(path.join(SESSIONS_DIR, dir))
              .filter(f => f.endsWith('.jsonl'));
            totalFiles += files.length;
          }
        }

        sendUserMessage(`📁 Found ${totalFiles} session files across ${projectDirs.length} projects\n⏳ Indexing...`);

        const memoryDir = path.join(os.homedir(), '.pi', 'agent', 'memory');
        const dbManager = new DatabaseManager(memoryDir);

        try {
          const result = indexAllSessions(dbManager, SESSIONS_DIR);
          const stats = getSessionStats(dbManager);

          let output = `\n✅ Session indexing complete!\n\n`;
          output += `📊 Results:\n`;
          output += `├─ Sessions processed: ${result.sessionsProcessed}\n`;
          output += `├─ Sessions indexed: ${result.sessionsIndexed}\n`;
          output += `├─ Sessions skipped (already indexed): ${result.sessionsSkipped}\n`;
          output += `└─ Messages indexed: ${result.messagesIndexed}\n`;

          if (stats.projects.length > 0) {
            output += `\n📁 Projects indexed:\n`;
            for (const p of stats.projects) {
              output += `├─ ${p.project}: ${p.sessions} sessions, ${p.messages} messages\n`;
            }
          }

          // Show totals
          output += `\n📈 Database totals:\n`;
          output += `├─ ${stats.totalSessions} sessions\n`;
          output += `├─ ${stats.totalMessages} messages\n`;
          output += `└─ ${stats.projects.length} projects\n`;

          if (result.errors.length > 0) {
            output += `\n⚠️ Errors (${result.errors.length}):\n`;
            for (const err of result.errors.slice(0, 3)) {
              output += `├─ ${err}\n`;
            }
            if (result.errors.length > 3) {
              output += `└─ ... and ${result.errors.length - 3} more\n`;
            }
          }

          output += `\n💡 Use the session_search tool to search across indexed sessions.`;

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
