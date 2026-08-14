import type { Screening } from '../db/repositories/screenings.js';
import type { JobRecord } from '../db/repositories/jobs.js';

/**
 * Decides which roles are worth a model call today.
 *
 * A daily run is capped, so the cap has to keep the *best* roles rather than
 * whichever ones the database returned first. Ranking is deterministic and
 * free: it uses the screening verdict we already computed, so it costs nothing
 * and cannot be influenced by a posting's persuasive writing.
 *
 * This is priority, not fit. It answers "which of these is most likely to repay
 * an expensive evaluation", and it never claims to know the answer the model
 * will give.
 */

export interface RankedJob {
  job: JobRecord;
  priority: number;
  /** Shown to the user, so a cap never silently drops something unexplained. */
  reason: string;
}

const FRESHNESS = { current: 25, unknown: 8, stale: 0 } as const;
const INTENT = { specific: 25, unknown: 8, evergreen: 0 } as const;
const FRAUD = { low: 20, medium: 4, high: 0 } as const;
const PROVENANCE = { verified: 15, unverified: 6, suspicious: 0 } as const;

function daysSince(timestamp: string | undefined, now: number): number | undefined {
  if (!timestamp) return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : (now - parsed) / 86_400_000;
}

export function scoreJob(job: JobRecord, screening: Screening | undefined, now: number): RankedJob {
  const notes: string[] = [];
  let priority = 0;

  if (screening) {
    const { freshness, hiringIntent, fraudRisk, provenance } = screening.authenticity;

    priority += FRESHNESS[freshness] ?? 0;
    priority += INTENT[hiringIntent] ?? 0;
    priority += FRAUD[fraudRisk] ?? 0;
    priority += PROVENANCE[provenance] ?? 0;

    if (hiringIntent === 'evergreen') notes.push('looks evergreen');
    if (freshness === 'stale') notes.push('stale');
    if (fraudRisk !== 'low') notes.push(`${fraudRisk} fraud risk`);

    // Each warning is a thing the user would have to check by hand anyway.
    priority -= Math.min(screening.warnings.length * 4, 12);
    if (screening.warnings.length > 0) notes.push(`${screening.warnings.length} warning(s)`);
  } else {
    notes.push('not screened yet');
  }

  // A stated salary removes the single most common unknown in a decision.
  if (job.salaryMin !== undefined || job.salaryMax !== undefined) {
    priority += 10;
  } else {
    notes.push('no stated pay');
  }

  // A posting with no body cannot be assessed well at any price.
  if (job.descriptionText && job.descriptionText.length > 400) priority += 8;
  else notes.push('thin description');

  const age = daysSince(job.postedAt ?? job.firstSeenAt, now);
  if (age !== undefined) {
    if (age <= 7) priority += 12;
    else if (age <= 21) priority += 6;
    else if (age > 60) notes.push('over 60 days old');
  }

  return {
    job,
    priority,
    reason: notes.length === 0 ? 'fresh, specific, and fully stated' : notes.join(', '),
  };
}

export function rankForEvaluation(
  jobs: JobRecord[],
  screeningFor: (jobId: string) => Screening | undefined,
  now = Date.now(),
): RankedJob[] {
  return jobs
    .map((job) => scoreJob(job, screeningFor(job.id), now))
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      // Stable and explicable: newer first, then by id so runs are reproducible.
      const byDate = (b.job.postedAt ?? b.job.firstSeenAt ?? '').localeCompare(a.job.postedAt ?? a.job.firstSeenAt ?? '');
      return byDate !== 0 ? byDate : a.job.id.localeCompare(b.job.id);
    });
}

/**
 * Above this many roles a run stops being something you watch.
 *
 * Not a limit — the user may set any number — but an agent CLI takes minutes
 * per role, so 20 is roughly where a "daily run" becomes an overnight job. The
 * warning states the measured cost rather than scolding.
 */
export const LARGE_RUN_THRESHOLD = 20;

export function largeRunWarning(limit: number, minutesPerRole: number): string | undefined {
  if (limit <= LARGE_RUN_THRESHOLD) return undefined;

  const hours = (limit * minutesPerRole) / 60;
  const estimate = hours >= 1 ? `${hours.toFixed(1)} hours` : `${Math.round(hours * 60)} minutes`;

  return `${limit} roles per run is a long run: roughly ${estimate} at the current provider's measured speed.`;
}
