import type { CriteriaConfig } from '../config/schema.js';
import type { Repositories } from '../db/repositories/index.js';
import type { JobRecord } from '../db/repositories/jobs.js';
import type { Screening } from '../db/repositories/screenings.js';
import { nowIso, type IsoTimestamp } from '../util/time.js';
import { createCriteriaContext } from './criteria.js';
import { applyHardFilters } from './hard-filters.js';
import { screenAuthenticity } from './authenticity.js';

/**
 * Runs deterministic screening over stored roles.
 *
 * This is the gate in front of every expensive stage: a role that fails here is
 * never sent to a model. It is also the only stage that can run on a schedule
 * with no provider configured and no spending at all.
 */

export interface ScreenOptions {
  criteria: CriteriaConfig;
  /** Re-screen roles already screened under the same criteria. */
  force?: boolean | undefined;
  limit?: number | undefined;
  now?: IsoTimestamp | undefined;
}

export interface ScreenSummary {
  criteriaHash: string;
  screened: number;
  reused: number;
  eligible: number;
  rejected: number;
  blocked: number;
  /** Rejections by rule, so the user can see which filter is doing the work. */
  rejectionsByRule: Record<string, number>;
}

/** Screens one role. Pure apart from the reads it needs for history. */
export function screenJob(
  repos: Repositories,
  job: JobRecord,
  criteria: CriteriaConfig,
  criteriaHash: string,
  now: IsoTimestamp,
): Screening {
  const postings = repos.postings.listForJob(job.id);
  const events = repos.events.listForJob(job.id);

  const filters = applyHardFilters({ job, postings }, criteria);

  const duplicateCompanyCount = job.contentKey ? repos.jobs.countCompaniesSharingContent(job.contentKey) : 1;

  const authenticity = screenAuthenticity(
    { job, postings, events, duplicateCompanyCount, now },
    criteria.screening,
  );

  return repos.screenings.save({
    jobId: job.id,
    screenedAt: now,
    criteriaHash,
    eligible: filters.eligible,
    rejections: filters.rejections,
    warnings: filters.warnings,
    authenticity,
  });
}

export function runScreening(repos: Repositories, options: ScreenOptions): ScreenSummary {
  const { criteria } = options;
  const context = createCriteriaContext(criteria);
  const now = options.now ?? nowIso();

  const jobs = repos.jobs.list({ inScope: true, limit: options.limit ?? 1000 });

  const summary: ScreenSummary = {
    criteriaHash: context.hash,
    screened: 0,
    reused: 0,
    eligible: 0,
    rejected: 0,
    blocked: 0,
    rejectionsByRule: {},
  };

  for (const job of jobs) {
    const existing = options.force ? undefined : repos.screenings.findCurrent(job.id, context.hash);

    // Screening is cheap, but re-deciding an unchanged role under unchanged
    // rules would churn the record for no new information.
    const screening = existing ?? screenJob(repos, job, criteria, context.hash, now);

    if (existing) summary.reused += 1;
    else summary.screened += 1;

    if (screening.authenticity.blocked) summary.blocked += 1;
    if (screening.eligible) summary.eligible += 1;
    else summary.rejected += 1;

    for (const rejection of screening.rejections) {
      summary.rejectionsByRule[rejection.rule] = (summary.rejectionsByRule[rejection.rule] ?? 0) + 1;
    }
  }

  return summary;
}
