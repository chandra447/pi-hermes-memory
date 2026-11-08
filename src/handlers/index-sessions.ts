/**
 * Index sessions command — /memory-index-sessions imports past sessions into SQLite.
 */

import path from 'node:path';
import fs from 'node:fs';
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DatabaseManager } from '../store/db.js';
import { indexAllSessions, getSessionStats, retentionCutoffMs } from '../store/session-indexer.js';
import { getSessionFiles, isSessionFile } from '../store/session-parser.js';
import type { MemoryConfig } from '../types.js';
import { AGENT_ROOT } from '../paths.js';

const SESSIONS_DIR = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(AGENT_ROOT, 'sessions');

/** Preflight count mirroring the indexer's filtered view: session files, the
 *  sniffed-out non-session remainder, and the project dirs touched. */
function countSessionFilesWithSkips(sessionsDir: string, excludeDirs: string[] = []): { sessions: number; nonSession: number; projects: string[] } {
  if (!fs.existsSync(sessionsDir)) return { sessions: 0, nonSession: 0, projects: [] };
  const all = getSessionFiles(sessionsDir, undefined, excludeDirs, false);
  let sessions = 0;
  const projects = new Set<string>();
  for (const file of all) {
    if (!isSessionFile(file)) continue;
    sessions++;
    const parent = path.basename(path.dirname(file));
    if (parent !== path.basename(sessionsDir)) projects.add(parent);
  }
  return { sessions, nonSession: all.length - sessions, projects: [...projects] };
}

export function registerIndexSessionsCommand(pi: ExtensionAPI, config: MemoryConfig): void {
  pi.registerCommand("memory-index-sessions", {
    description: "Import past Pi sessions into the search database",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      // Show initial progress
      ctx.ui.notify('🔍 Scanning session directories...', 'info');

      try {
        // Count sessions first for progress display — same filtered view the
        // indexer runs (sessionIndexExclude dirs dropped, non-session jsonl
        // sniffed out), so "Found N" matches what will actually be processed.
        const countResult = countSessionFilesWithSkips(SESSIONS_DIR, config.sessionIndexExclude);
        const totalFiles = countResult.sessions;
        const nonSessionFiles = countResult.nonSession;
        const projectDirs = countResult.projects;

        ctx.ui.notify(`📁 Found ${totalFiles} session files across ${projectDirs.length} projects${nonSessionFiles > 0 ? ` (${nonSessionFiles} non-session files will be skipped)` : ''}\n⏳ Indexing...`, 'info');

        const memoryDir = path.join(AGENT_ROOT, 'pi-hermes-memory');
        const dbManager = new DatabaseManager(memoryDir);

        try {
          // Retention is honored here too: a manual reindex must not re-add the
          // expired sessions the auto pruning just deleted.
          const result = indexAllSessions(dbManager, SESSIONS_DIR, undefined, retentionCutoffMs(config.sessionRetentionDays), config.sessionIndexExclude);
          const stats = getSessionStats(dbManager);

          let output = `\n✅ Session indexing complete!\n\n`;
          output += `📊 Results:\n`;
          output += `├─ Sessions processed: ${result.sessionsProcessed}\n`;
          output += `├─ Sessions indexed: ${result.sessionsIndexed}\n`;
          output += `├─ Sessions skipped (already indexed): ${result.sessionsSkipped}\n`;
          if (result.nonSessionSkipped) {
            output += `├─ Non-session files skipped: ${result.nonSessionSkipped}\n`;
          }
          if (result.expiredSkipped) {
            output += `├─ Sessions skipped (outside retention): ${result.expiredSkipped}\n`;
          }
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

          ctx.ui.notify(output, 'info');
        } finally {
          dbManager.close();
        }
      } catch (err) {
        ctx.ui.notify(`❌ Session indexing failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },
  });
}
