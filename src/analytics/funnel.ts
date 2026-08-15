import type { Database } from '../db/database.js';

/**
 * The funnel, computed from records.
 *
 * Every number here is a query over rows the system already keeps, and none of
 * it is cached. That is the rule from architecture.md §22 — the model may
 * explain these results and must never calculate them — and it has a second
 * consequence worth stating: a stored metric cannot be checked against the
 * events that produced it, so nothing is stored.
 *
 * The stages beyond `applied` are read from `application_status_events`, not
 * from the current status. An application that reached a final round and was
 * then rejected *had* a final round; counting only where things ended up would
 * report a pipeline in which nobody was ever interviewed.
 */

export const FUNNEL_STAGES = [
  'discovered',
  'in_scope',
  'screened',
  'eligible',
  'evaluated',
  'recommended',
  'applied',
  'recruiter_screen',
  'interviewing',
  'final',
  'offer',
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export interface FunnelResult {
  since: string | undefined;
  until: string | undefined;
  counts: Record<FunnelStage, number>;
  rates: {
    /** Of the roles evaluated, how many were recommended. */
    recommendationRate: number | undefined;
    /** Of the roles recommended, how many were applied to. */
    applyRate: number | undefined;
    /** Of the applications, how many reached a recruiter. */
    screenRate: number | undefined;
    /** Of the applications, how many reached an interview. */
    interviewRate: number | undefined;
    /** Of the applications, how many produced an offer. */
    offerRate: number | undefined;
  };
  /** Where the user disagreed with the advice, in both directions. */
  overrides: { kind: string; count: number }[];
}

interface Window {
  since: string | undefined;
  /**
   * Exclusive. A month window is [the 1st, the 1st of the next month), so an
   * application made at exactly midnight on 1 August belongs to August and to
   * nothing else. An inclusive bound put it in July as well, and two adjacent
   * reports that each claim the same application cannot both be right.
   */
  until: string | undefined;
}

function windowClause(column: string, window: Window): string {
  const parts: string[] = [];
  if (window.since) parts.push(`${column} >= @since`);
  if (window.until) parts.push(`${column} < @until`);
  return parts.length > 0 ? `AND ${parts.join(' AND ')}` : '';
}

function count(db: Database, sql: string, params: Record<string, unknown>): number {
  const row = db.prepare(sql).get(params) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Whether an application ever reached a status.
 *
 * `application_status_events` is append-only, so this is a question about
 * history rather than about the row's cached current state.
 */
function reached(db: Database, status: string, window: Window): number {
  return count(
    db,
    `SELECT COUNT(DISTINCT applications.id) AS n
     FROM applications
     JOIN application_status_events events ON events.application_id = applications.id
     WHERE events.to_status = @status
       ${windowClause('COALESCE(applications.applied_at, applications.created_at)', window)}`,
    { status, since: window.since, until: window.until },
  );
}

export function funnel(db: Database, window: Window = { since: undefined, until: undefined }): FunnelResult {
  const params = { since: window.since, until: window.until };

  const discovered = count(
    db,
    `SELECT COUNT(*) AS n FROM jobs WHERE 1 = 1 ${windowClause('jobs.first_seen_at', window)}`,
    params,
  );

  const inScope = count(
    db,
    `SELECT COUNT(*) AS n FROM jobs WHERE jobs.in_scope = 1 ${windowClause('jobs.first_seen_at', window)}`,
    params,
  );

  const screened = count(
    db,
    `SELECT COUNT(DISTINCT job_id) AS n FROM job_screenings WHERE 1 = 1 ${windowClause('screened_at', window)}`,
    params,
  );

  const eligible = count(
    db,
    `SELECT COUNT(DISTINCT job_id) AS n FROM job_screenings
     WHERE eligible = 1 AND blocked = 0 ${windowClause('screened_at', window)}`,
    params,
  );

  const evaluated = count(
    db,
    `SELECT COUNT(DISTINCT job_id) AS n FROM evaluations WHERE 1 = 1 ${windowClause('created_at', window)}`,
    params,
  );

  // The latest verdict per role, *as of the window*. Taking the latest overall
  // and then filtering by date loses July's recommendation the moment the role
  // is re-evaluated in September: the subquery returns September, the outer
  // filter discards it, and a month that had a recommendation reports none.
  const recommended = count(
    db,
    `SELECT COUNT(*) AS n FROM (
       SELECT job_id, decision FROM evaluations outer_eval
       WHERE outer_eval.id = (
         SELECT latest.id FROM evaluations latest
         WHERE latest.job_id = outer_eval.job_id
           ${windowClause('latest.created_at', window)}
         ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1
       )
     ) WHERE decision = 'APPLY'`,
    params,
  );

  const applied = count(
    db,
    `SELECT COUNT(*) AS n FROM applications
     WHERE 1 = 1 ${windowClause('COALESCE(applied_at, created_at)', window)}`,
    params,
  );

  const counts: Record<FunnelStage, number> = {
    discovered,
    in_scope: inScope,
    screened,
    eligible,
    evaluated,
    recommended,
    applied,
    recruiter_screen: reached(db, 'RECRUITER_SCREEN', window),
    interviewing: reached(db, 'INTERVIEWING', window),
    final: reached(db, 'FINAL', window),
    offer: reached(db, 'OFFER', window),
  };

  const overrides = db
    .prepare(
      `SELECT kind, COUNT(*) AS n FROM role_feedback
       WHERE kind != 'agreed' ${windowClause('created_at', window)}
       GROUP BY kind ORDER BY n DESC`,
    )
    .all(params) as { kind: string; n: number }[];

  return {
    since: window.since,
    until: window.until,
    counts,
    rates: {
      recommendationRate: ratio(counts.recommended, counts.evaluated),
      applyRate: ratio(counts.applied, counts.recommended),
      screenRate: ratio(counts.recruiter_screen, counts.applied),
      interviewRate: ratio(counts.interviewing, counts.applied),
      offerRate: ratio(counts.offer, counts.applied),
    },
    overrides: overrides.map((row) => ({ kind: row.kind, count: row.n })),
  };
}

/** A rate with no denominator is unknown, not zero. */
function ratio(numerator: number, denominator: number): number | undefined {
  return denominator > 0 ? numerator / denominator : undefined;
}

export const SEGMENT_DIMENSIONS = [
  'company',
  'source',
  'country',
  'level',
  'department',
  'arrangement',
  'archetype',
  'decision',
  'salary_band',
  'month',
] as const;

export type SegmentDimension = (typeof SEGMENT_DIMENSIONS)[number];

export interface SegmentRow {
  segment: string;
  applications: number;
  screens: number;
  interviews: number;
  offers: number;
  screenRate: number | undefined;
  offerRate: number | undefined;
}

/**
 * How each dimension is derived.
 *
 * Salary bands are cut on the stated minimum, and a posting with no stated pay
 * lands in "unstated" rather than in the lowest band — most postings state
 * nothing, and folding them into "under 150k" would invent a fact about every
 * one of them.
 */
const DIMENSION_SQL: Record<SegmentDimension, string> = {
  company: 'companies.name',
  source: `(SELECT posting.source_type FROM source_postings posting WHERE posting.job_id = jobs.id ORDER BY posting.first_seen_at LIMIT 1)`,
  country: `COALESCE(jobs.country, 'unknown')`,
  level: `COALESCE(jobs.level, 'unstated')`,
  department: `COALESCE(jobs.department, 'unstated')`,
  arrangement: 'jobs.work_arrangement',
  archetype: `COALESCE(applications.archetype_id, 'unassigned')`,
  decision: `COALESCE(applications.decision_at_apply, 'unevaluated')`,
  salary_band: `CASE
      WHEN jobs.salary_min IS NULL THEN 'unstated'
      WHEN jobs.salary_min < 150000 THEN 'under 150k'
      WHEN jobs.salary_min < 200000 THEN '150k-200k'
      WHEN jobs.salary_min < 250000 THEN '200k-250k'
      ELSE '250k+'
    END`,
  month: `substr(COALESCE(applications.applied_at, applications.created_at), 1, 7)`,
};

/**
 * The funnel cut by one dimension.
 *
 * Only applications are segmented. Segmenting discovery would answer "which
 * companies post the most jobs", which is a fact about the internet; segmenting
 * outcomes answers "where is my time actually going", which is a fact about the
 * user.
 */
export function segments(
  db: Database,
  dimension: SegmentDimension,
  window: Window = { since: undefined, until: undefined },
): SegmentRow[] {
  const expression = DIMENSION_SQL[dimension];

  const rows = db
    .prepare(
      `SELECT
         ${expression} AS segment,
         COUNT(*) AS applications,
         SUM(CASE WHEN EXISTS (
           SELECT 1 FROM application_status_events e
           WHERE e.application_id = applications.id AND e.to_status = 'RECRUITER_SCREEN') THEN 1 ELSE 0 END) AS screens,
         SUM(CASE WHEN EXISTS (
           SELECT 1 FROM application_status_events e
           WHERE e.application_id = applications.id AND e.to_status IN ('INTERVIEWING', 'FINAL')) THEN 1 ELSE 0 END) AS interviews,
         SUM(CASE WHEN EXISTS (
           SELECT 1 FROM application_status_events e
           WHERE e.application_id = applications.id AND e.to_status = 'OFFER') THEN 1 ELSE 0 END) AS offers
       FROM applications
       JOIN jobs ON jobs.id = applications.job_id
       JOIN companies ON companies.id = jobs.company_id
       WHERE 1 = 1 ${windowClause('COALESCE(applications.applied_at, applications.created_at)', window)}
       GROUP BY segment
       ORDER BY applications DESC, segment`,
    )
    .all({ since: window.since, until: window.until }) as Array<{
    segment: string | null;
    applications: number;
    screens: number;
    interviews: number;
    offers: number;
  }>;

  return rows.map((row) => ({
    segment: row.segment ?? 'unknown',
    applications: row.applications,
    screens: row.screens,
    interviews: row.interviews,
    offers: row.offers,
    screenRate: ratio(row.screens, row.applications),
    offerRate: ratio(row.offers, row.applications),
  }));
}
