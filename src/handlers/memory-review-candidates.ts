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
import { SkillStore } from '../store/skill-store.js';
import { canPromoteToSkill, composeSkillDraft } from '../skills/skill-draft-composer.js';

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
  skillStore: SkillStore,
  selectedIds: number[],
  candidates: MemoryCandidate[],
): Promise<void> {
  if (selectedIds.length === 0) {
    ctx.ui.notify('Select at least one candidate first.', 'warning');
    return;
  }

  const latestSelected = listCandidates(dbManager, { limit: 500 }).filter((c) => selectedIds.includes(c.id));
  const approvedSelected = latestSelected;
  const gate = canPromoteToSkill(approvedSelected);
  if (!gate.ok) {
    ctx.ui.notify(gate.reason ?? 'Promotion requirements not met.', 'warning');
    return;
  }

  const skillNameInput = await ctx.ui.input('Skill name for promotion', 'e.g. sqlite-schema-drift-migration');
  if (!skillNameInput || !skillNameInput.trim()) return;

  const draft = composeSkillDraft(approvedSelected, skillNameInput.trim());

  const confirmed = await ctx.ui.confirm(
    'Create skill draft and promote candidates?',
    `Create skill '${draft.name}' from ${approvedSelected.length} candidate(s) and mark selected candidates as promoted.`,
  );
  if (!confirmed) {
    ctx.ui.notify('Promotion cancelled.', 'info');
    return;
  }

  const created = await skillStore.create(draft.name, draft.description, draft.body);
  if (!created.success || !created.fileName) {
    ctx.ui.notify(`Skill creation failed: ${created.error ?? 'unknown error'}`, 'error');
    return;
  }

  let promoted = 0;
  for (const id of selectedIds) {
    if (markPromoted(dbManager, id, draft.name)) promoted++;
  }

  if (promoted === 0) {
    ctx.ui.notify(`Skill '${draft.name}' was created, but no candidates were promoted (approval gate).`, 'warning');
    return;
  }

  ctx.ui.notify(`Created skill '${draft.name}' and promoted ${promoted} candidate(s).`, 'info');
  if (draft.warnings.length > 0) {
    ctx.ui.notify(`Draft warnings: ${draft.warnings.join(' | ')}`, 'warning');
  }
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

export function registerMemoryReviewCandidatesCommand(pi: ExtensionAPI, dbManager: DatabaseManager, skillStore: SkillStore): void {
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
          await promoteSelected(ctx, dbManager, skillStore, [...selected], candidates);
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
