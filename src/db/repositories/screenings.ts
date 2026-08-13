import type { Database } from '../database.js';
import { randomId } from '../../util/hash.js';
import { fromDb, toDb } from './row-mapping.js';
import type { IsoTimestamp } from '../../util/time.js';
import type { FilterResult } from '../../evaluate/hard-filters.js';
import type { AuthenticitySignal, AuthenticityVerdict } from '../../evaluate/authenticity.js';

export interface Screening {
  id: string;
  jobId: string;
  screenedAt: IsoTimestamp;
  criteriaHash: string;
  eligible: boolean;
  rejections: FilterResult[];
  warnings: FilterResult[];
  authenticity: AuthenticityVerdict;
}

interface ScreeningRow {
  id: string;
  job_id: string;
  screened_at: string;
  criteria_hash: string;
  eligible: number;
  rejections_json: string;
  warnings_json: string;
  freshness: string;
  hiring_intent: string;
  fraud_risk: string;
  provenance: string;
  signals_json: string;
  blocked: number;
}

function parse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function mapRow(row: ScreeningRow): Screening {
  return {
    id: row.id,
    jobId: row.job_id,
    screenedAt: row.screened_at,
    criteriaHash: row.criteria_hash,
    eligible: row.eligible !== 0,
    rejections: parse<FilterResult[]>(row.rejections_json, []),
    warnings: parse<FilterResult[]>(row.warnings_json, []),
    authenticity: {
      freshness: row.freshness as AuthenticityVerdict['freshness'],
      hiringIntent: row.hiring_intent as AuthenticityVerdict['hiringIntent'],
      fraudRisk: row.fraud_risk as AuthenticityVerdict['fraudRisk'],
      provenance: row.provenance as AuthenticityVerdict['provenance'],
      signals: parse<AuthenticitySignal[]>(row.signals_json, []),
      blocked: row.blocked !== 0,
    },
  };
}

export interface ScreeningInput {
  jobId: string;
  screenedAt: IsoTimestamp;
  criteriaHash: string;
  eligible: boolean;
  rejections: FilterResult[];
  warnings: FilterResult[];
  authenticity: AuthenticityVerdict;
}

/**
 * Screening results, keyed by job and criteria hash.
 *
 * Changing the rules produces a new row rather than overwriting the old one, so
 * the record of what was decided under which rules survives.
 */
export class ScreeningRepository {
  constructor(private readonly db: Database) {}

  findCurrent(jobId: string, criteriaHash: string): Screening | undefined {
    const row = this.db
      .prepare('SELECT * FROM job_screenings WHERE job_id = ? AND criteria_hash = ?')
      .get(jobId, criteriaHash) as ScreeningRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  latestForJob(jobId: string): Screening | undefined {
    const row = this.db
      .prepare('SELECT * FROM job_screenings WHERE job_id = ? ORDER BY screened_at DESC LIMIT 1')
      .get(jobId) as ScreeningRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  save(input: ScreeningInput): Screening {
    const existing = this.findCurrent(input.jobId, input.criteriaHash);
    const id = existing?.id ?? randomId('scr');

    this.db
      .prepare(
        `INSERT INTO job_screenings (
           id, job_id, screened_at, criteria_hash, eligible, rejections_json, warnings_json,
           freshness, hiring_intent, fraud_risk, provenance, signals_json, blocked
         ) VALUES (
           @id, @job_id, @screened_at, @criteria_hash, @eligible, @rejections_json, @warnings_json,
           @freshness, @hiring_intent, @fraud_risk, @provenance, @signals_json, @blocked
         )
         ON CONFLICT(job_id, criteria_hash) DO UPDATE SET
           screened_at = excluded.screened_at,
           eligible = excluded.eligible,
           rejections_json = excluded.rejections_json,
           warnings_json = excluded.warnings_json,
           freshness = excluded.freshness,
           hiring_intent = excluded.hiring_intent,
           fraud_risk = excluded.fraud_risk,
           provenance = excluded.provenance,
           signals_json = excluded.signals_json,
           blocked = excluded.blocked`,
      )
      .run({
        id,
        job_id: input.jobId,
        screened_at: input.screenedAt,
        criteria_hash: input.criteriaHash,
        eligible: input.eligible ? 1 : 0,
        rejections_json: JSON.stringify(input.rejections),
        warnings_json: JSON.stringify(input.warnings),
        freshness: input.authenticity.freshness,
        hiring_intent: input.authenticity.hiringIntent,
        fraud_risk: input.authenticity.fraudRisk,
        provenance: input.authenticity.provenance,
        signals_json: JSON.stringify(input.authenticity.signals),
        blocked: input.authenticity.blocked ? 1 : 0,
      });

    const saved = this.findCurrent(input.jobId, input.criteriaHash);
    if (!saved) throw new Error(`failed to read back screening for ${input.jobId}`);
    return saved;
  }

  /** Jobs that passed every hard filter and are not blocked. */
  listEligible(criteriaHash: string, limit = 50): Screening[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM job_screenings
         WHERE criteria_hash = ? AND eligible = 1 AND blocked = 0
         ORDER BY screened_at DESC LIMIT ?`,
      )
      .all(criteriaHash, limit) as ScreeningRow[];
    return rows.map(mapRow);
  }

  countsFor(criteriaHash: string): { total: number; eligible: number; blocked: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN eligible = 1 THEN 1 ELSE 0 END) AS eligible,
                SUM(CASE WHEN blocked = 1 THEN 1 ELSE 0 END) AS blocked
         FROM job_screenings WHERE criteria_hash = ?`,
      )
      .get(criteriaHash) as { total: number; eligible: number | null; blocked: number | null };

    return { total: row.total, eligible: row.eligible ?? 0, blocked: row.blocked ?? 0 };
  }
}

/** Spend accounting. Populated from phase 3b; readable from today. */
export interface LlmCallInput {
  jobId: string | undefined;
  evaluationId: string | undefined;
  stage: string;
  provider: string;
  model: string;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  estimatedCostUsd: number | undefined;
  requestCount: number;
  cacheHit: boolean;
  succeeded: boolean;
  error: string | undefined;
  createdAt: IsoTimestamp;
}

export interface SpendSummary {
  stage: string;
  model: string;
  calls: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export class LlmCallRepository {
  constructor(private readonly db: Database) {}

  record(input: LlmCallInput): void {
    this.db
      .prepare(
        `INSERT INTO llm_calls (
           id, job_id, evaluation_id, stage, provider, model, input_tokens, output_tokens,
           estimated_cost_usd, request_count, cache_hit, succeeded, error, created_at
         ) VALUES (
           @id, @job_id, @evaluation_id, @stage, @provider, @model, @input_tokens, @output_tokens,
           @estimated_cost_usd, @request_count, @cache_hit, @succeeded, @error, @created_at
         )`,
      )
      .run({
        id: randomId('llm'),
        job_id: toDb(input.jobId),
        evaluation_id: toDb(input.evaluationId),
        stage: input.stage,
        provider: input.provider,
        model: input.model,
        input_tokens: toDb(input.inputTokens),
        output_tokens: toDb(input.outputTokens),
        estimated_cost_usd: toDb(input.estimatedCostUsd),
        request_count: input.requestCount,
        cache_hit: input.cacheHit ? 1 : 0,
        succeeded: input.succeeded ? 1 : 0,
        error: toDb(input.error),
        created_at: input.createdAt,
      });
  }

  /** Spend by stage and model, including failed attempts. */
  summarize(since?: IsoTimestamp | undefined): SpendSummary[] {
    const rows = this.db
      .prepare(
        `SELECT stage, model,
                COUNT(*) AS calls,
                SUM(request_count) AS requests,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(estimated_cost_usd), 0) AS cost
         FROM llm_calls
         WHERE (@since IS NULL OR created_at >= @since)
         GROUP BY stage, model
         ORDER BY cost DESC`,
      )
      .all({ since: toDb(since) }) as Array<{
      stage: string;
      model: string;
      calls: number;
      requests: number;
      input_tokens: number;
      output_tokens: number;
      cost: number;
    }>;

    return rows.map((row) => ({
      stage: row.stage,
      model: row.model,
      calls: row.calls,
      requests: row.requests,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      estimatedCostUsd: row.cost,
    }));
  }

  totalCost(since?: IsoTimestamp | undefined): number {
    const row = this.db
      .prepare(
        'SELECT COALESCE(SUM(estimated_cost_usd), 0) AS cost FROM llm_calls WHERE (@since IS NULL OR created_at >= @since)',
      )
      .get({ since: toDb(since) }) as { cost: number };
    return row.cost;
  }
}

export { fromDb };
