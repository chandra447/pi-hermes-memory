import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent';
import {
  extractCandidatesFromIndexedMessages,
  type CandidateExtractionResult,
} from '../store/candidate-extractor.js';
import { getCandidateStats } from '../store/candidate-store.js';
import { DatabaseManager } from '../store/db.js';
import type { MemoryConfig } from '../types.js';

function notifyStats(ctx: ExtensionCommandContext, stats: ReturnType<typeof getCandidateStats>): void {
  ctx.ui.notify(
    [
      '',
      '  ╔══════════════════════════════════════════════╗',
      '  ║       📈 Memory Candidate Stats               ║',
      '  ╚══════════════════════════════════════════════╝',
      '',
      `  Total:    ${stats.total}`,
      `  Pending:  ${stats.pending}`,
      `  Approved: ${stats.approved}`,
      `  Rejected: ${stats.rejected}`,
      `  Promoted: ${stats.promoted}`,
    ].join('\n'),
    'info',
  );
}

export function registerMemoryCandidatesStatsCommand(pi: ExtensionAPI, dbManager: DatabaseManager): void {
  pi.registerCommand('memory-candidates-stats', {
    description: 'Show pending/approved/rejected/promoted candidate counts',
    handler: async (_args, ctx) => {
      const stats = getCandidateStats(dbManager);
      notifyStats(ctx, stats);
    },
  });
}

export function registerMemoryCandidatesRebuildCommand(
  pi: ExtensionAPI,
  dbManager: DatabaseManager,
  config: MemoryConfig,
  deps: {
    extract?: typeof extractCandidatesFromIndexedMessages;
  } = {},
): void {
  pi.registerCommand('memory-candidates-rebuild', {
    description: 'Rebuild memory candidates from indexed session JSONL source-of-truth',
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm(
        'Rebuild memory candidates from indexed sessions?',
        'This clears current candidate rows and rebuilds them from indexed session messages.',
      );

      if (!confirmed) {
        ctx.ui.notify('Candidate rebuild cancelled.', 'info');
        return;
      }

      const db = dbManager.getDb();
      const extract = deps.extract ?? extractCandidatesFromIndexedMessages;

      let deletedRows = 0;
      let result: CandidateExtractionResult | null = null;

      const tx = db.transaction(() => {
        const deleted = db.prepare('DELETE FROM memory_candidates').run();
        deletedRows = deleted.changes;
        result = extract(dbManager, {
          minConfidence: config.candidateConfidenceThreshold,
        });
      });

      try {
        tx();
      } catch {
        ctx.ui.notify('Candidate rebuild failed; previous candidates were restored.', 'error');
        return;
      }

      if (!result) {
        ctx.ui.notify('Candidate rebuild failed unexpectedly.', 'error');
        return;
      }
      const finalResult = result as CandidateExtractionResult;

      ctx.ui.notify(
        [
          `Rebuilt candidates (confidence >= ${config.candidateConfidenceThreshold}).`,
          `Deleted existing rows: ${deletedRows}`,
          `Sessions scanned: ${finalResult.sessionsScanned}`,
          `Messages scanned: ${finalResult.messagesScanned}`,
          `Candidates added: ${finalResult.candidatesAdded}`,
          `Duplicates skipped: ${finalResult.duplicatesSkipped}`,
          `Low confidence skipped: ${finalResult.lowConfidenceSkipped}`,
        ].join('\n'),
        'info',
      );

      notifyStats(ctx, getCandidateStats(dbManager));
    },
  });
}
