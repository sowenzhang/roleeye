import type { DiscoveredJob, JobEventType } from '../core/types.js';
import type { CaptureMode } from '../config/schema.js';
import type { Repositories } from '../db/repositories/index.js';
import type { JobWithCompany } from '../db/repositories/jobs.js';
import { normalizeDiscoveredJob, type NormalizedJob } from '../normalize/job.js';
import { classifyReappearance } from '../normalize/repost.js';
import { evaluateScope, type EffectiveScope } from './scope.js';
import type { IsoTimestamp } from '../util/time.js';

export type IngestOutcome = 'new' | 'changed' | 'reposted' | 'unchanged';

export interface IngestResult {
  jobId: string;
  outcome: IngestOutcome;
  matchedBy: 'identity-key' | 'canonical-url' | 'fingerprint' | 'none';
  detail: string | undefined;
  inScope: boolean;
}

export interface IngestOptions {
  seenAt: IsoTimestamp;
  scanId: string | undefined;
  repostGapDays: number;
  captureMode?: CaptureMode | undefined;
  scope?: EffectiveScope | undefined;
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
 *
 * Capture mode decides how much is kept. `scoped` skips out-of-scope postings
 * entirely, `history` keeps metadata without the body, and `full` keeps
 * everything while still recording the scope decision.
 */
export function ingestJob(
  repos: Repositories,
  discovered: DiscoveredJob,
  options: IngestOptions,
): IngestResult | undefined {
  const captureMode: CaptureMode = options.captureMode ?? 'scoped';
  let normalized = normalizeDiscoveredJob(discovered);

  const verdict = options.scope
    ? evaluateScope(
        {
          title: normalized.title,
          level: normalized.level,
          department: normalized.department,
          team: normalized.team,
          locationText: normalized.locationText,
          country: normalized.country,
          workArrangement: normalized.workArrangement,
          postedAt: normalized.postedAt,
        },
        options.scope,
        options.seenAt,
      )
    : { inScope: true, reason: undefined };

  // `scoped` is the default: out-of-scope roles are never stored, so the
  // database stays about roles the user actually cares about.
  if (!verdict.inScope && captureMode === 'scoped') return undefined;

  // `history` keeps the market record without paying to store or analyze bodies.
  if (captureMode === 'history') {
    normalized = stripBody(normalized);
  }

  const company = repos.companies.upsertByName(normalized.companyName);
  const existing = findExisting(repos, normalized);

  if (!existing) {
    const job = repos.jobs.insert(normalized, company.id, options.seenAt, {
      captureMode,
      inScope: verdict.inScope,
      scopeReason: verdict.reason,
    });

    if (normalized.descriptionText.length > 0) {
      repos.snapshots.insertIfNew({
        jobId: job.id,
        capturedAt: options.seenAt,
        sourceUrl: normalized.sourceUrl,
        rawPayload: normalized.rawPayload,
        normalizedDescription: normalized.descriptionText,
        descriptionHash: normalized.descriptionHash,
      });
    }

    repos.events.insert({
      jobId: job.id,
      seenAt: options.seenAt,
      sourceType: normalized.sourceType,
      sourceJobId: normalized.sourceJobId,
      url: normalized.sourceUrl,
      eventType: 'discovered',
      detail: verdict.inScope ? undefined : `out of scope: ${verdict.reason ?? 'unspecified'}`,
      scanId: options.scanId,
    });

    return {
      jobId: job.id,
      outcome: 'new',
      matchedBy: 'none',
      detail: undefined,
      inScope: verdict.inScope,
    };
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
  repos.jobs.markSeen(job.id, normalized, options.seenAt, {
    updateContent: contentChanged,
    captureMode,
    inScope: verdict.inScope,
    scopeReason: verdict.reason,
  });

  if (contentChanged && normalized.descriptionText.length > 0) {
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

  return {
    jobId: job.id,
    outcome,
    matchedBy: existing.matchedBy,
    detail: decision.reason,
    inScope: verdict.inScope,
  };
}

/** Keeps identity and metadata; drops the body a `history` source does not need. */
function stripBody(normalized: NormalizedJob): NormalizedJob {
  return { ...normalized, descriptionText: '', rawPayload: undefined };
}
