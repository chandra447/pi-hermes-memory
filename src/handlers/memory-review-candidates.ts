import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent';
import {
  listCandidates,
  markPromoted,
  mergeCandidates,
  updateCandidateDetails,
  updateCandidateStatus,
  type MemoryCandidate,
} from '../store/candidate-store.js';
import { DatabaseManager } from '../store/db.js';

function candidateLabel(c: MemoryCandidate, selected: boolean): string {
  const mark = selected ? '[x]' : '[ ]';
  const snippet = c.snippet.length > 64 ? `${c.snippet.slice(0, 64)}…` : c.snippet;
  const project = c.project ?? 'global';
  return `${mark} #${c.id} [${c.status}] ${(c.confidence * 100).toFixed(0)}% ${c.tag} @${project} — ${snippet}`;
}

function parseStatusFilter(rawArgs: string | undefined): MemoryCandidate['status'] | undefined {
  if (!rawArgs) return undefined;
  const match = rawArgs.match(/--status\s+(pending|approved|rejected|promoted)\b/i);
  return match?.[1]?.toLowerCase() as MemoryCandidate['status'] | undefined;
}

function notifySummary(ctx: ExtensionCommandContext, candidates: MemoryCandidate[]): void {
  const counts = {
    pending: 0,
    approved: 0,
    rejected: 0,
    promoted: 0,
  };

  for (const c of candidates) counts[c.status]++;

  ctx.ui.notify(
    [
      '',
      '  ╔══════════════════════════════════════════════╗',
      '  ║         🧪 Candidate Review Summary          ║',
      '  ╚══════════════════════════════════════════════╝',
      '',
      `  Pending:  ${counts.pending}`,
      `  Approved: ${counts.approved}`,
      `  Rejected: ${counts.rejected}`,
      `  Promoted: ${counts.promoted}`,
    ].join('\n'),
    'info',
  );
}

async function promoteSelected(
  ctx: ExtensionCommandContext,
  dbManager: DatabaseManager,
  selectedIds: number[],
  candidates: MemoryCandidate[],
): Promise<void> {
  if (selectedIds.length === 0) {
    ctx.ui.notify('Select at least one candidate first.', 'warning');
    return;
  }

  const approvedSelected = candidates.filter((c) => selectedIds.includes(c.id) && c.status === 'approved');
  if (approvedSelected.length === 0) {
    ctx.ui.notify('No approved candidates selected. Approve candidates before promotion.', 'warning');
    return;
  }

  const skillName = await ctx.ui.input('Skill name for promotion', 'e.g. sqlite-schema-drift-migration');
  if (!skillName || !skillName.trim()) return;

  let promoted = 0;
  let skipped = 0;

  for (const id of selectedIds) {
    if (markPromoted(dbManager, id, skillName.trim())) promoted++;
    else skipped++;
  }

  ctx.ui.notify(`Promoted ${promoted} candidate(s). Skipped ${skipped} (must be approved first).`, 'info');
}

function updateStatusSelected(
  ctx: ExtensionCommandContext,
  dbManager: DatabaseManager,
  selectedIds: number[],
  status: 'approved' | 'rejected',
): void {
  if (selectedIds.length === 0) {
    ctx.ui.notify('Select at least one candidate first.', 'warning');
    return;
  }

  let updated = 0;
  for (const id of selectedIds) {
    if (updateCandidateStatus(dbManager, id, status)) updated++;
  }

  ctx.ui.notify(`${status === 'approved' ? 'Approved' : 'Rejected'} ${updated}/${selectedIds.length} candidate(s).`, 'info');
}

export function registerMemoryReviewCandidatesCommand(pi: ExtensionAPI, dbManager: DatabaseManager): void {
  pi.registerCommand('memory-review-candidates', {
    description: 'Interactive TUI review for memory candidates (select, triage, and promote)',
    handler: async (args, ctx) => {
      const rawArgs = typeof args === 'string' ? args : undefined;
      const statusFilter = parseStatusFilter(rawArgs);
      const selected = new Set<number>();

      while (true) {
        const candidates = listCandidates(dbManager, {
          status: statusFilter,
          limit: 200,
        });

        if (candidates.length === 0) {
          ctx.ui.notify('No candidates found for review.', 'info');
          return;
        }

        const options = [
          ...candidates.map((c) => candidateLabel(c, selected.has(c.id))),
          '── Actions ──',
          '✅ Approve selected',
          '❌ Reject selected',
          '✏️ Edit selected (single)',
          '🔀 Merge selected (pick primary)',
          '🚀 Promote selected (approved only)',
          '🧹 Clear selection',
          '📊 Show status summary',
          '✅ Done',
        ];

        const choice = await ctx.ui.select('Memory Candidate Review', options, {});
        if (!choice || choice === '✅ Done') return;

        if (choice === '── Actions ──') continue;
        if (choice === '🧹 Clear selection') {
          selected.clear();
          continue;
        }
        if (choice === '📊 Show status summary') {
          notifySummary(ctx, candidates);
          continue;
        }
        if (choice === '✅ Approve selected') {
          updateStatusSelected(ctx, dbManager, [...selected], 'approved');
          continue;
        }
        if (choice === '❌ Reject selected') {
          updateStatusSelected(ctx, dbManager, [...selected], 'rejected');
          continue;
        }
        if (choice === '✏️ Edit selected (single)') {
          if (selected.size !== 1) {
            ctx.ui.notify('Select exactly one candidate to edit.', 'warning');
            continue;
          }
          const id = [...selected][0];
          const current = candidates.find((c) => c.id === id);
          if (!current) continue;

          const nextTag = await ctx.ui.input('Edit tag (leave empty to keep current)', current.tag);
          const nextSnippet = await ctx.ui.input('Edit snippet (leave empty to keep current)', current.snippet);
          const nextRationale = await ctx.ui.input('Edit rationale (leave empty to keep current)', current.rationale);

          const ok = updateCandidateDetails(dbManager, id, {
            tag: nextTag ?? undefined,
            snippet: nextSnippet ?? undefined,
            rationale: nextRationale ?? undefined,
          });
          if (ok) ctx.ui.notify(`Updated candidate #${id}.`, 'info');
          continue;
        }
        if (choice === '🔀 Merge selected (pick primary)') {
          if (selected.size !== 2) {
            ctx.ui.notify('Select exactly two candidates to merge.', 'warning');
            continue;
          }

          const selectedRows = candidates.filter((c) => selected.has(c.id));
          const primaryChoice = await ctx.ui.select(
            'Select primary candidate (secondary will be rejected)',
            selectedRows.map((c) => `#${c.id} ${c.tag} — ${c.snippet.slice(0, 50)}`),
            {},
          );
          if (!primaryChoice) continue;

          const primaryId = Number(primaryChoice.match(/#(\d+)/)?.[1]);
          const secondaryId = selectedRows.find((c) => c.id !== primaryId)?.id;
          if (!Number.isInteger(primaryId) || !secondaryId) continue;

          const ok = mergeCandidates(dbManager, primaryId, secondaryId);
          if (ok) {
            ctx.ui.notify(`Merged #${secondaryId} into #${primaryId}.`, 'info');
            selected.clear();
            selected.add(primaryId);
          }
          continue;
        }
        if (choice === '🚀 Promote selected (approved only)') {
          await promoteSelected(ctx, dbManager, [...selected], candidates);
          continue;
        }

        const idMatch = choice.match(/#(\d+)/);
        if (!idMatch) continue;
        const id = Number(idMatch[1]);
        if (!Number.isInteger(id)) continue;

        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
      }
    },
  });
}
