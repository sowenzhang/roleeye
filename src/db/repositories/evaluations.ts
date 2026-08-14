import type { EvaluationDecision } from '../../core/types.js';
import { randomId } from '../../util/hash.js';
import type { IsoTimestamp } from '../../util/time.js';
import type { Database } from '../database.js';
import { fromDb, toDb } from './row-mapping.js';

/**
 * Stored evaluations.
 *
 * Every row names the snapshot it judged and the hashes of the content,
 * profile, criteria, prompts, and model that produced it. That is what makes
 * the cache safe: an edit to any of those yields a different key, so a stale
 * verdict can never be silently reused.
 */

export interface EvaluationRecord {
  id: string;
  jobId: string;
  snapshotId: string | undefined;
  createdAt: IsoTimestamp;
  decision: EvaluationDecision;
  score: number;
  confidence: number | undefined;
  headline: string | undefined;
  contentHash: string | undefined;
  profileHash: string | undefined;
  criteriaHash: string | undefined;
  staleAt: IsoTimestamp | undefined;
  advocate: unknown;
  skeptic: unknown;
  judge: unknown;
}

interface EvaluationRow {
  id: string;
  job_id: string;
  snapshot_id: string | null;
  created_at: string;
  decision: string;
  score: number;
  confidence: number | null;
  headline: string | null;
  content_hash: string | null;
  profile_hash: string | null;
  criteria_hash: string | null;
  stale_at: string | null;
  advocate_json: string | null;
  skeptic_json: string | null;
  judge_json: string | null;
}

function parse(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function mapRow(row: EvaluationRow): EvaluationRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    snapshotId: fromDb(row.snapshot_id),
    createdAt: row.created_at,
    decision: row.decision as EvaluationDecision,
    score: row.score,
    confidence: fromDb(row.confidence),
    headline: fromDb(row.headline),
    contentHash: fromDb(row.content_hash),
    profileHash: fromDb(row.profile_hash),
    criteriaHash: fromDb(row.criteria_hash),
    staleAt: fromDb(row.stale_at),
    advocate: parse(row.advocate_json),
    skeptic: parse(row.skeptic_json),
    judge: parse(row.judge_json),
  };
}

export interface EvaluationInput {
  jobId: string;
  snapshotId: string | undefined;
  createdAt: IsoTimestamp;
  decision: EvaluationDecision;
  score: number;
  confidence: number;
  headline: string;
  contentHash: string;
  profileHash: string;
  criteriaHash: string;
  assessment: unknown;
  skeptic: unknown;
  scoring: unknown;
}

export class EvaluationRepository {
  constructor(private readonly db: Database) {}

  /** The cache lookup. All five hashes must match for a verdict to be reused. */
  findCurrent(jobId: string, keys: { contentHash: string; profileHash: string; criteriaHash: string }):
    | EvaluationRecord
    | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM evaluations
         WHERE job_id = @jobId AND content_hash = @contentHash
           AND profile_hash = @profileHash AND criteria_hash = @criteriaHash
           AND stale_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get({ jobId, ...keys }) as EvaluationRow | undefined;

    return row ? mapRow(row) : undefined;
  }

  latestForJob(jobId: string): EvaluationRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM evaluations WHERE job_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(jobId) as EvaluationRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  save(input: EvaluationInput): EvaluationRecord {
    const id = randomId('eval');

    this.db
      .prepare(
        `INSERT INTO evaluations (
           id, job_id, snapshot_id, profile_version, criteria_version, created_at,
           decision, score, confidence, headline,
           advocate_json, skeptic_json, judge_json,
           career_direction_fit, career_direction_reason,
           content_hash, profile_hash, criteria_hash
         ) VALUES (
           @id, @job_id, @snapshot_id, NULL, NULL, @created_at,
           @decision, @score, @confidence, @headline,
           @advocate_json, @skeptic_json, @judge_json,
           NULL, NULL,
           @content_hash, @profile_hash, @criteria_hash
         )`,
      )
      .run({
        id,
        job_id: input.jobId,
        snapshot_id: toDb(input.snapshotId),
        created_at: input.createdAt,
        decision: input.decision,
        score: input.score,
        confidence: input.confidence,
        headline: input.headline,
        advocate_json: JSON.stringify(input.assessment ?? null),
        skeptic_json: JSON.stringify(input.skeptic ?? null),
        judge_json: JSON.stringify(input.scoring ?? null),
        content_hash: input.contentHash,
        profile_hash: input.profileHash,
        criteria_hash: input.criteriaHash,
      });

    const saved = this.db.prepare('SELECT * FROM evaluations WHERE id = ?').get(id) as EvaluationRow;
    return mapRow(saved);
  }

  /** Recommendations, best first, restricted to still-current verdicts. */
  listRecommendations(limit = 20, minimumDecision: EvaluationDecision[] = ['APPLY', 'MAYBE']): EvaluationRecord[] {
    const placeholders = minimumDecision.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT e.* FROM evaluations e
         JOIN jobs j ON j.id = e.job_id
         WHERE e.decision IN (${placeholders})
           AND e.stale_at IS NULL
           AND j.closed_at IS NULL
           AND e.created_at = (SELECT MAX(created_at) FROM evaluations WHERE job_id = e.job_id)
         ORDER BY e.score DESC, e.created_at DESC
         LIMIT ?`,
      )
      .all(...minimumDecision, limit) as EvaluationRow[];

    return rows.map(mapRow);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM evaluations').get() as { n: number };
    return row.n;
  }
}
