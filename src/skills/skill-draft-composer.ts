import type { MemoryCandidate } from '../store/candidate-store.js';

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
  warnings: string[];
}

function toNameFragment(tag: string): string {
  return tag.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function normalizeLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function unique(lines: string[]): string[] {
  return [...new Set(lines.map(normalizeLine).filter(Boolean))];
}

export function canPromoteToSkill(candidates: MemoryCandidate[]): { ok: boolean; reason?: string } {
  if (candidates.length === 0) return { ok: false, reason: 'No candidates selected.' };

  const approved = candidates.filter((c) => c.status === 'approved');
  if (approved.length !== candidates.length) {
    return { ok: false, reason: 'All selected candidates must be approved before promotion.' };
  }

  const hasRepeatedEvidence = approved.some((c) => (c.evidenceCount ?? 0) >= 2);
  if (!hasRepeatedEvidence) {
    return { ok: false, reason: 'Promotion requires at least one approved candidate with evidence_count >= 2.' };
  }

  return { ok: true };
}

export function composeSkillDraft(candidates: MemoryCandidate[], skillName?: string): SkillDraft {
  const sorted = [...candidates].sort((a, b) => (b.evidenceCount - a.evidenceCount) || (b.confidence - a.confidence));
  const top = sorted[0];
  const tag = top?.tag ?? 'workflow';

  const inferredName = `${toNameFragment(tag) || 'workflow'}-playbook`;
  const name = (skillName?.trim() || inferredName).replace(/\s+/g, '-').toLowerCase();
  const description = `Operational playbook distilled from ${sorted.length} approved memory candidate(s) for ${tag}.`;

  const whenToUse = unique(sorted.map((c) => c.tag ? `Use when working on ${c.tag} scenarios.` : 'Use when this scenario repeats.'));
  const procedure = unique(sorted.map((c, idx) => `${idx + 1}. ${normalizeLine(c.snippet)}`));
  const pitfalls = unique(
    sorted
      .map((c) => normalizeLine(c.rationale))
      .filter((r) => r.length > 0)
      .map((r) => `- ${r}`),
  );
  const verification = unique([
    ...sorted.map((c) => `- Confirm outcome linked to: ${normalizeLine(c.snippet).slice(0, 90)}`),
    '- Re-run relevant checks/tests before finalizing.',
  ]);

  const warnings: string[] = [];
  if (procedure.length < 2) warnings.push('Procedure section is sparse; review and expand before relying on this skill.');
  if (pitfalls.length === 0) warnings.push('Pitfalls section is sparse; add known failure modes.');

  const body = [
    '## When to Use',
    whenToUse.length > 0 ? whenToUse.map((l) => `- ${l}`).join('\n') : '- Use when this workflow repeats.',
    '',
    '## Procedure',
    procedure.length > 0 ? procedure.join('\n') : '1. Follow the documented workflow step-by-step.',
    '',
    '## Pitfalls',
    pitfalls.length > 0 ? pitfalls.join('\n') : '- Watch for edge cases and regressions not covered by the initial evidence.',
    '',
    '## Verification',
    verification.length > 0 ? verification.join('\n') : '- Verify expected behavior with targeted tests.',
  ].join('\n');

  return { name, description, body, warnings };
}
