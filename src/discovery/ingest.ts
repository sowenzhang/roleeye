import type { DiscoveredJob, JobEventType } from '../core/types.js';
import type { CaptureMode } from '../config/schema.js';
import type { Repositories } from '../db/repositories/index.js';
import type { SourcePosting } from '../db/repositories/source-postings.js';
import { normalizeDiscoveredJob, type NormalizedJob } from '../normalize/job.js';
import { classifyReappearance } from '../normalize/repost.js';
import { evaluateScope, type EffectiveScope } from './scope.js';
import type { IsoTimestamp } from '../util/time.js';

export type IngestOutcome = 'new' | 'changed' | 'reposted' | 'unchanged' | 'skipped' | 'deferred';

export type PostingMatch = 'identity-key' | 'source-url' | 'none';
export type JobMatch = 'cluster-key' | 'new';

export interface IngestResult {
  jobId: string | undefined;
  postingId: string | undefined;
  outcome: IngestOutcome;
  /** How the incoming posting matched a stored posting. */
  matchedBy: PostingMatch;
  /** How the posting was attached to a logical role. */
  clusteredBy: JobMatch | undefined;
  detail: string | undefined;
  inScope: boolean;
  isNewPosting: boolean;
}

export interface IngestOptions {
  seenAt: IsoTimestamp;
  scanId: string | undefined;
  repostGapDays: number;
  captureMode?: CaptureMode | undefined;
  scope?: EffectiveScope | undefined;
  /** Manual capture ignores scope: a human already decided this role matters. */
  ignoreScope?: boolean | undefined;
  /**
   * When false, a posting we have never seen is left for the next scan instead
   * of being stored. Known postings are always refreshed, so a cap can never
   * stop us observing roles we already track.
   */
  allowNew?: boolean | undefined;
}

/**
 * Finds the stored posting this observation refers to.
 *
 * Matching stays within one source. Two providers advertising the same role are
 * two postings, not one posting that keeps changing identity — conflating them
 * is what made every scan report a repost.
 */
function findPosting(
  repos: Repositories,
  normalized: NormalizedJob,
): { posting: SourcePosting; matchedBy: PostingMatch } | undefined {
  const byKey = repos.postings.findByIdentityKey(normalized.identityKey);
  if (byKey) return { posting: byKey, matchedBy: 'identity-key' };

  // Same source, same URL, new id: an ATS reissued the requisition.
  const url = normalized.canonicalUrl ?? normalized.applyUrl;
  if (url) {
    const byUrl = repos.postings.findBySourceAndUrl(normalized.sourceName, url);
    if (byUrl) return { posting: byUrl, matchedBy: 'source-url' };
  }

  return undefined;
}

/**
 * Ingests one discovered posting.
 *
 * Idempotent: repeating a scan yields one job, one posting per source, one
 * snapshot per distinct body, and one event per observation.
 *
 * Capture mode controls how much is kept. `scoped` does not start tracking
 * out-of-scope roles but still refreshes ones already stored, so a role leaving
 * scope does not silently stop being observed. `history` keeps identity and
 * metadata without the body. `full` keeps everything.
 */
export function ingestJob(repos: Repositories, discovered: DiscoveredJob, options: IngestOptions): IngestResult {
  const captureMode: CaptureMode = options.captureMode ?? 'scoped';
  const normalized = normalizeDiscoveredJob(discovered);
  const keepBody = captureMode !== 'history';

  const verdict =
    options.scope && !options.ignoreScope
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

  const scopeState = { inScope: verdict.inScope, scopeReason: verdict.reason };
  const existing = findPosting(repos, normalized);

  // Out of scope and not already tracked: do not start tracking it.
  if (!verdict.inScope && captureMode === 'scoped' && !existing) {
    return {
      jobId: undefined,
      postingId: undefined,
      outcome: 'skipped',
      matchedBy: 'none',
      clusteredBy: undefined,
      detail: verdict.reason,
      inScope: false,
      isNewPosting: false,
    };
  }

  // Over the per-scan cap for new roles. Deferred, not dropped: the next scan
  // sees it again, because nothing about it was recorded.
  if (!existing && options.allowNew === false) {
    return {
      jobId: undefined,
      postingId: undefined,
      outcome: 'deferred',
      matchedBy: 'none',
      clusteredBy: undefined,
      detail: 'per-scan cap for new roles reached',
      inScope: verdict.inScope,
      isNewPosting: false,
    };
  }

  const stored = keepBody ? normalized : withoutBody(normalized);

  return existing
    ? updateExisting(repos, existing, normalized, stored, options, captureMode, scopeState, keepBody)
    : insertNew(repos, normalized, stored, options, captureMode, scopeState, keepBody);
}

interface ScopeState {
  inScope: boolean;
  scopeReason: string | undefined;
}

function insertNew(
  repos: Repositories,
  normalized: NormalizedJob,
  stored: NormalizedJob,
  options: IngestOptions,
  captureMode: CaptureMode,
  scopeState: ScopeState,
  keepBody: boolean,
): IngestResult {
  const company = repos.companies.upsertByName(normalized.companyName);

  // Attach to an existing role when the same company already advertises
  // identical content elsewhere; otherwise this is a new role.
  const clustered = normalized.clusterKey
    ? repos.jobs.findByClusterKey(company.id, normalized.clusterKey)
    : undefined;

  const job = clustered ?? repos.jobs.insert(stored, company.id, options.seenAt, scopeState);
  const clusteredBy: JobMatch = clustered ? 'cluster-key' : 'new';

  if (clustered) {
    // A second source may carry a body the first one lacked.
    repos.jobs.markSeen(job.id, stored, options.seenAt, {
      updateContent: !clustered.hasBody && stored.descriptionText.length > 0,
      scope: scopeState,
    });
  }

  const hasBody = keepBody && normalized.descriptionText.length > 0;
  const posting = repos.postings.insert(job.id, normalized, options.seenAt, { captureMode, hasBody });

  if (hasBody) {
    repos.snapshots.insertIfNew({
      jobId: job.id,
      postingId: posting.id,
      capturedAt: options.seenAt,
      sourceUrl: normalized.sourceUrl,
      rawPayload: normalized.rawPayload,
      normalizedDescription: normalized.descriptionText,
      descriptionHash: normalized.descriptionHash,
    });
  }

  repos.events.insert({
    jobId: job.id,
    postingId: posting.id,
    seenAt: options.seenAt,
    sourceType: normalized.sourceType,
    sourceJobId: normalized.sourceJobId,
    url: normalized.sourceUrl,
    eventType: 'discovered',
    detail: clustered
      ? 'additional source for a known role'
      : scopeState.inScope
        ? undefined
        : `out of scope: ${scopeState.scopeReason ?? 'unspecified'}`,
    scanId: options.scanId,
  });

  return {
    jobId: job.id,
    postingId: posting.id,
    outcome: 'new',
    matchedBy: 'none',
    clusteredBy,
    detail: undefined,
    inScope: scopeState.inScope,
    isNewPosting: true,
  };
}

function updateExisting(
  repos: Repositories,
  existing: { posting: SourcePosting; matchedBy: PostingMatch },
  normalized: NormalizedJob,
  stored: NormalizedJob,
  options: IngestOptions,
  captureMode: CaptureMode,
  scopeState: ScopeState,
  keepBody: boolean,
): IngestResult {
  const posting = existing.posting;
  const job = repos.jobs.findById(posting.jobId);
  if (!job) throw new Error(`posting ${posting.id} references missing job ${posting.jobId}`);

  const decision = classifyReappearance({
    lastSeenAt: posting.lastSeenAt,
    closedAt: posting.closedAt,
    previousSourceJobId: posting.sourceJobId,
    currentSourceJobId: normalized.sourceJobId,
    previousDescriptionHash: posting.descriptionHash ?? '',
    currentDescriptionHash: normalized.descriptionHash,
    seenAt: options.seenAt,
    repostGapDays: options.repostGapDays,
  });

  const contentChanged = posting.descriptionHash !== normalized.descriptionHash;
  const incomingHasBody = keepBody && normalized.descriptionText.length > 0;

  // A role first seen through a metadata-only source now has a body. Hashes
  // match in that case, so content equality alone would never trigger a write.
  const needsBackfill = incomingHasBody && !job.hasBody;
  const writeContent = incomingHasBody && (contentChanged || needsBackfill);

  repos.postings.markSeen(posting.id, normalized, options.seenAt, {
    captureMode,
    // Never downgrade a posting that already produced a stored body.
    hasBody: incomingHasBody || posting.hasBody,
  });

  repos.jobs.markSeen(job.id, stored, options.seenAt, { updateContent: writeContent, scope: scopeState });

  if (writeContent) {
    repos.snapshots.insertIfNew({
      jobId: job.id,
      postingId: posting.id,
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
    postingId: posting.id,
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
    postingId: posting.id,
    outcome,
    matchedBy: existing.matchedBy,
    clusteredBy: undefined,
    detail: decision.reason,
    inScope: scopeState.inScope,
    isNewPosting: false,
  };
}

/**
 * Drops the body for `history` capture while keeping the hash.
 *
 * The hash records what the source advertised even when the text is not
 * retained, so a later switch to `full` recognises the body as new content
 * rather than concluding nothing changed.
 */
function withoutBody(normalized: NormalizedJob): NormalizedJob {
  return { ...normalized, descriptionText: '', rawPayload: undefined };
}
