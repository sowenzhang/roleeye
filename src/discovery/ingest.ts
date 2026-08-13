import type { DiscoveredJob, JobEventType } from '../core/types.js';
import type { Repositories } from '../db/repositories/index.js';
import type { JobWithCompany } from '../db/repositories/jobs.js';
import { normalizeDiscoveredJob, type NormalizedJob } from '../normalize/job.js';
import { classifyReappearance } from '../normalize/repost.js';
import type { IsoTimestamp } from '../util/time.js';

export type IngestOutcome = 'new' | 'changed' | 'reposted' | 'unchanged';

export interface IngestResult {
  jobId: string;
  outcome: IngestOutcome;
  matchedBy: 'identity-key' | 'canonical-url' | 'fingerprint' | 'none';
  detail: string | undefined;
}

export interface IngestOptions {
  seenAt: IsoTimestamp;
  scanId: string | undefined;
  repostGapDays: number;
}

/**
 * Resolves an incoming posting to an existing job using the identity hierarchy
 * from architecture.md §12. Titles alone never merge two jobs.
 */
function findExisting(
  repos: Repositories,
  normalized: NormalizedJob,
): { job: JobWithCompany; matchedBy: IngestResult['matchedBy'] } | undefined {
  const byKey = repos.jobs.findByIdentityKey(normalized.identityKey);
  if (byKey) return { job: byKey, matchedBy: 'identity-key' };

  const url = normalized.canonicalUrl ?? normalized.applyUrl;
  if (url) {
    const byUrl = repos.jobs.findByCanonicalUrl(url);
    if (byUrl) return { job: byUrl, matchedBy: 'canonical-url' };
  }

  const byFingerprint = repos.jobs.findByFingerprint(normalized.fingerprint);
  if (byFingerprint) return { job: byFingerprint, matchedBy: 'fingerprint' };

  return undefined;
}

/**
 * Ingests one discovered posting.
 *
 * Idempotent: running the same scan twice produces one job, one snapshot per
 * distinct content, and one event per observation.
 */
export function ingestJob(repos: Repositories, discovered: DiscoveredJob, options: IngestOptions): IngestResult {
  const normalized = normalizeDiscoveredJob(discovered);
  const company = repos.companies.upsertByName(normalized.companyName);
  const existing = findExisting(repos, normalized);

  if (!existing) {
    const job = repos.jobs.insert(normalized, company.id, options.seenAt);

    repos.snapshots.insertIfNew({
      jobId: job.id,
      capturedAt: options.seenAt,
      sourceUrl: normalized.sourceUrl,
      rawPayload: normalized.rawPayload,
      normalizedDescription: normalized.descriptionText,
      descriptionHash: normalized.descriptionHash,
    });

    repos.events.insert({
      jobId: job.id,
      seenAt: options.seenAt,
      sourceType: normalized.sourceType,
      sourceJobId: normalized.sourceJobId,
      url: normalized.sourceUrl,
      eventType: 'discovered',
      detail: undefined,
      scanId: options.scanId,
    });

    return { jobId: job.id, outcome: 'new', matchedBy: 'none', detail: undefined };
  }

  const job = existing.job;
  const decision = classifyReappearance({
    lastSeenAt: job.lastSeenAt,
    closedAt: job.closedAt,
    previousSourceJobId: job.sourceJobId,
    currentSourceJobId: normalized.sourceJobId,
    previousDescriptionHash: job.descriptionHash,
    currentDescriptionHash: normalized.descriptionHash,
    seenAt: options.seenAt,
    repostGapDays: options.repostGapDays,
  });

  const contentChanged = job.descriptionHash !== normalized.descriptionHash;
  repos.jobs.markSeen(job.id, normalized, options.seenAt, { updateContent: contentChanged });

  if (contentChanged) {
    repos.snapshots.insertIfNew({
      jobId: job.id,
      capturedAt: options.seenAt,
      sourceUrl: normalized.sourceUrl,
      rawPayload: normalized.rawPayload,
      normalizedDescription: normalized.descriptionText,
      descriptionHash: normalized.descriptionHash,
    });
  }

  const eventType: JobEventType = decision.eventType;
  repos.events.insert({
    jobId: job.id,
    seenAt: options.seenAt,
    sourceType: normalized.sourceType,
    sourceJobId: normalized.sourceJobId,
    url: normalized.sourceUrl,
    eventType,
    detail: decision.reason,
    scanId: options.scanId,
  });

  const outcome: IngestOutcome =
    eventType === 'reposted' ? 'reposted' : eventType === 'changed' ? 'changed' : 'unchanged';

  return { jobId: job.id, outcome, matchedBy: existing.matchedBy, detail: decision.reason };
}
