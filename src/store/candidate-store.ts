import { createHash } from 'node:crypto';
import { DatabaseManager } from './db.js';

export type CandidateStatus = 'pending' | 'approved' | 'rejected' | 'promoted';
export type CandidateSourceType = 'correction' | 'failure' | 'tool_sequence' | 'explicit_tag';

export interface MemoryCandidate {
  id: number;
  sessionId: string;
  messageId: string | null;
  project: string | null;
  tag: string;
  snippet: string;
  rationale: string;
  confidence: number;
  status: CandidateStatus;
  sourceType: CandidateSourceType;
  extractorRule: string;
  evidenceCount: number;
  toolState: string | null;
  timestamp: string;
  createdAt: string;
  updatedAt: string;
  promotedSkill: string | null;
  dedupeKey: string | null;
}

export interface AddCandidateInput {
  sessionId: string;
  messageId?: string | null;
  project?: string | null;
  tag: string;
  snippet: string;
  rationale: string;
  confidence: number;
  sourceType: CandidateSourceType;
  extractorRule: string;
  evidenceCount?: number;
  toolState?: string | null;
  timestamp: string;
  dedupeKey?: string | null;
}

export interface ListCandidatesOptions {
  status?: CandidateStatus;
  project?: string | null;
  tag?: string;
  limit?: number;
}

export interface UpdateCandidateDetailsInput {
  tag?: string;
  snippet?: string;
  rationale?: string;
}

interface CandidateRow {
  id: number;
  session_id: string;
  message_id: string | null;
  project: string | null;
  tag: string;
  snippet: string;
  rationale: string;
  confidence: number;
  status: CandidateStatus | 'new';
  source_type: CandidateSourceType;
  extractor_rule: string;
  evidence_count: number;
  tool_state: string | null;
  timestamp: string;
  created_at: string;
  updated_at: string;
  promoted_skill: string | null;
  dedupe_key: string | null;
}

function normalizeStatus(status: CandidateRow['status']): CandidateStatus {
  return status === 'new' ? 'pending' : status;
}

function stableHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function mapCandidate(row: CandidateRow): MemoryCandidate {
  return {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id,
    project: row.project,
    tag: row.tag,
    snippet: row.snippet,
    rationale: row.rationale,
    confidence: row.confidence,
    status: normalizeStatus(row.status),
    sourceType: row.source_type,
    extractorRule: row.extractor_rule,
    evidenceCount: row.evidence_count,
    toolState: row.tool_state,
    timestamp: row.timestamp,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    promotedSkill: row.promoted_skill,
    dedupeKey: row.dedupe_key,
  };
}

export function addCandidate(dbManager: DatabaseManager, input: AddCandidateInput): MemoryCandidate | null {
  const db = dbManager.getDb();
  const now = new Date().toISOString();

  const resolvedMessageId = input.messageId ?? `hash:${stableHash([input.sessionId, input.timestamp, input.tag, input.extractorRule, input.snippet].join('|'))}`;
  const resolvedDedupeKey = input.dedupeKey ?? `${input.sessionId}|${resolvedMessageId}|${input.tag}|${input.extractorRule}`;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO memory_candidates (
      session_id,
      message_id,
      project,
      tag,
      snippet,
      rationale,
      confidence,
      source_type,
      extractor_rule,
      evidence_count,
      tool_state,
      timestamp,
      created_at,
      updated_at,
      dedupe_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = insert.run(
    input.sessionId,
    resolvedMessageId,
    input.project ?? null,
    input.tag,
    input.snippet,
    input.rationale,
    input.confidence,
    input.sourceType,
    input.extractorRule,
    input.evidenceCount ?? 1,
    input.toolState ?? null,
    input.timestamp,
    now,
    now,
    resolvedDedupeKey
  );

  if (result.changes === 0) return null;

  const row = db.prepare('SELECT * FROM memory_candidates WHERE id = ?').get(result.lastInsertRowid) as CandidateRow | undefined;
  return row ? mapCandidate(row) : null;
}

export function listCandidates(dbManager: DatabaseManager, options: ListCandidatesOptions = {}): MemoryCandidate[] {
  const db = dbManager.getDb();
  const { status, project, tag, limit = 100 } = options;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (status) {
    if (status === 'pending') {
      conditions.push("(status = 'pending' OR status = 'new')");
    } else {
      conditions.push('status = ?');
      params.push(status);
    }
  }

  if (project !== undefined) {
    if (project === null) {
      conditions.push('project IS NULL');
    } else {
      conditions.push('project = ?');
      params.push(project);
    }
  }

  if (tag) {
    conditions.push('tag = ?');
    params.push(tag);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT *
    FROM memory_candidates
    ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit) as CandidateRow[];

  return rows.map(mapCandidate);
}

export function updateCandidateStatus(dbManager: DatabaseManager, id: number, status: CandidateStatus): boolean {
  const db = dbManager.getDb();
  const existing = db.prepare('SELECT status FROM memory_candidates WHERE id = ?').get(id) as { status: CandidateRow['status'] } | undefined;
  if (!existing) return false;

  if (normalizeStatus(existing.status) === 'promoted' && status !== 'promoted') {
    return false;
  }

  const result = db.prepare(`
    UPDATE memory_candidates
    SET status = ?, updated_at = ?
    WHERE id = ?
  `).run(status, new Date().toISOString(), id);

  return result.changes > 0;
}

export function updateCandidateDetails(dbManager: DatabaseManager, id: number, input: UpdateCandidateDetailsInput): boolean {
  const db = dbManager.getDb();
  const existing = db.prepare('SELECT id, tag, snippet, rationale FROM memory_candidates WHERE id = ?').get(id) as {
    id: number;
    tag: string;
    snippet: string;
    rationale: string;
  } | undefined;

  if (!existing) return false;

  const nextTag = input.tag?.trim() || existing.tag;
  const nextSnippet = input.snippet?.trim() || existing.snippet;
  const nextRationale = input.rationale?.trim() || existing.rationale;

  const result = db.prepare(`
    UPDATE memory_candidates
    SET tag = ?, snippet = ?, rationale = ?, updated_at = ?
    WHERE id = ?
  `).run(nextTag, nextSnippet, nextRationale, new Date().toISOString(), id);

  return result.changes > 0;
}

export function mergeCandidates(dbManager: DatabaseManager, primaryId: number, secondaryId: number): boolean {
  if (primaryId === secondaryId) return false;

  const db = dbManager.getDb();
  const primary = db.prepare('SELECT * FROM memory_candidates WHERE id = ?').get(primaryId) as CandidateRow | undefined;
  const secondary = db.prepare('SELECT * FROM memory_candidates WHERE id = ?').get(secondaryId) as CandidateRow | undefined;

  if (!primary || !secondary) return false;
  if (normalizeStatus(primary.status) === 'promoted' || normalizeStatus(secondary.status) === 'promoted') return false;

  const mergedSnippet = primary.snippet === secondary.snippet
    ? primary.snippet
    : `${primary.snippet}\n---\n${secondary.snippet}`;

  const mergedRationale = primary.rationale === secondary.rationale
    ? primary.rationale
    : `${primary.rationale}\nMerged from #${secondary.id}: ${secondary.rationale}`;

  const mergedEvidence = Math.max(1, (primary.evidence_count ?? 1) + (secondary.evidence_count ?? 1));
  const mergedConfidence = Math.max(primary.confidence, secondary.confidence);

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE memory_candidates
      SET snippet = ?, rationale = ?, evidence_count = ?, confidence = ?, updated_at = ?
      WHERE id = ?
    `).run(mergedSnippet, mergedRationale, mergedEvidence, mergedConfidence, new Date().toISOString(), primaryId);

    db.prepare(`
      UPDATE memory_candidates
      SET status = 'rejected', updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), secondaryId);
  });

  tx();
  return true;
}

export function markPromoted(dbManager: DatabaseManager, id: number, skillName: string): boolean {
  const db = dbManager.getDb();
  const existing = db.prepare('SELECT status FROM memory_candidates WHERE id = ?').get(id) as { status: CandidateRow['status'] } | undefined;
  if (!existing || normalizeStatus(existing.status) !== 'approved') {
    return false;
  }

  const result = db.prepare(`
    UPDATE memory_candidates
    SET status = 'promoted', promoted_skill = ?, updated_at = ?
    WHERE id = ?
  `).run(skillName, new Date().toISOString(), id);

  return result.changes > 0;
}
