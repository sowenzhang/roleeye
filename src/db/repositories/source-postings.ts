import type { SourceType } from '../../core/types.js';
import type { NormalizedJob } from '../../normalize/job.js';
import { shortHash } from '../../util/hash.js';
import { nowIso, type IsoTimestamp } from '../../util/time.js';
import type { Database } from '../database.js';
import { fromDb, toDb } from './row-mapping.js';

/**
 * One row per source advertising a role.
 *
 * Source identity lives here rather than on `jobs` so a role listed on two ATS
 * providers keeps both identities instead of one overwriting the other, and so
 * repost detection compares a source against itself.
 */
export interface SourcePosting {
  id: string;
  jobId: string;
  sourceType: SourceType;
  sourceName: string | undefined;
  sourceJobId: string | undefined;
  sourceUrl: string;
  canonicalUrl: string | undefined;
  applyUrl: string | undefined;
  applicationSystem: string | undefined;
  identityKey: string;
  identityTier: string;
  locationText: string | undefined;
  captureMode: string;
  descriptionHash: string | undefined;
  hasBody: boolean;
  postedAt: IsoTimestamp | undefined;
  firstSeenAt: IsoTimestamp;
  lastSeenAt: IsoTimestamp;
  closedAt: IsoTimestamp | undefined;
}

interface PostingRow {
  id: string;
  job_id: string;
  source_type: string;
  source_name: string | null;
  source_job_id: string | null;
  source_url: string;
  canonical_url: string | null;
  apply_url: string | null;
  application_system: string | null;
  identity_key: string;
  identity_tier: string;
  location_text: string | null;
  capture_mode: string;
  description_hash: string | null;
  has_body: number;
  posted_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  closed_at: string | null;
}

function mapRow(row: PostingRow): SourcePosting {
  return {
    id: row.id,
    jobId: row.job_id,
    sourceType: row.source_type as SourceType,
    sourceName: fromDb(row.source_name),
    sourceJobId: fromDb(row.source_job_id),
    sourceUrl: row.source_url,
    canonicalUrl: fromDb(row.canonical_url),
    applyUrl: fromDb(row.apply_url),
    applicationSystem: fromDb(row.application_system),
    identityKey: row.identity_key,
    identityTier: row.identity_tier,
    locationText: fromDb(row.location_text),
    captureMode: row.capture_mode,
    descriptionHash: fromDb(row.description_hash),
    hasBody: row.has_body !== 0,
    postedAt: fromDb(row.posted_at),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    closedAt: fromDb(row.closed_at),
  };
}

export function derivePostingId(identityKey: string): string {
  return `post_${shortHash(identityKey, 16)}`;
}

export class SourcePostingRepository {
  constructor(private readonly db: Database) {}

  findByIdentityKey(identityKey: string): SourcePosting | undefined {
    const row = this.db.prepare('SELECT * FROM source_postings WHERE identity_key = ?').get(identityKey) as
      | PostingRow
      | undefined;
    return row ? mapRow(row) : undefined;
  }

  /** Same source, same URL: catches an ATS reissuing a posting under a new id. */
  findBySourceAndUrl(sourceName: string | undefined, url: string): SourcePosting | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM source_postings
         WHERE (canonical_url = @url OR apply_url = @url)
           AND (@source IS NULL OR source_name IS @source)
         LIMIT 1`,
      )
      .get({ url, source: toDb(sourceName) }) as PostingRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  listForJob(jobId: string): SourcePosting[] {
    const rows = this.db
      .prepare('SELECT * FROM source_postings WHERE job_id = ? ORDER BY first_seen_at')
      .all(jobId) as PostingRow[];
    return rows.map(mapRow);
  }

  insert(
    jobId: string,
    normalized: NormalizedJob,
    seenAt: IsoTimestamp,
    options: { captureMode: string; hasBody: boolean },
  ): SourcePosting {
    const id = derivePostingId(normalized.identityKey);
    const timestamp = nowIso();

    this.db
      .prepare(
        `INSERT INTO source_postings (
           id, job_id, source_type, source_name, source_job_id, source_url, canonical_url,
           apply_url, application_system, identity_key, identity_tier, location_text,
           capture_mode, description_hash, has_body, posted_at, first_seen_at, last_seen_at,
           closed_at, created_at, updated_at
         ) VALUES (
           @id, @job_id, @source_type, @source_name, @source_job_id, @source_url, @canonical_url,
           @apply_url, @application_system, @identity_key, @identity_tier, @location_text,
           @capture_mode, @description_hash, @has_body, @posted_at, @first_seen_at, @last_seen_at,
           NULL, @created_at, @updated_at
         )`,
      )
      .run({
        id,
        job_id: jobId,
        source_type: normalized.sourceType,
        source_name: normalized.sourceName,
        source_job_id: toDb(normalized.sourceJobId),
        source_url: normalized.sourceUrl,
        canonical_url: toDb(normalized.canonicalUrl),
        apply_url: toDb(normalized.applyUrl),
        application_system: toDb(normalized.applicationSystem),
        identity_key: normalized.identityKey,
        identity_tier: normalized.identityTier,
        location_text: toDb(normalized.locationText),
        capture_mode: options.captureMode,
        description_hash: normalized.descriptionHash,
        has_body: options.hasBody ? 1 : 0,
        posted_at: toDb(normalized.postedAt),
        first_seen_at: seenAt,
        last_seen_at: seenAt,
        created_at: timestamp,
        updated_at: timestamp,
      });

    const inserted = this.findByIdentityKey(normalized.identityKey);
    if (!inserted) throw new Error(`failed to read back inserted posting ${id}`);
    return inserted;
  }

  /**
   * Records a fresh observation. `first_seen_at` is never rewritten and a
   * reappearance clears the closed marker.
   */
  markSeen(
    postingId: string,
    normalized: NormalizedJob,
    seenAt: IsoTimestamp,
    options: { captureMode: string; hasBody: boolean },
  ): void {
    this.db
      .prepare(
        `UPDATE source_postings SET
           source_job_id = COALESCE(@source_job_id, source_job_id),
           source_url = @source_url,
           canonical_url = @canonical_url,
           apply_url = @apply_url,
           application_system = @application_system,
           location_text = @location_text,
           capture_mode = @capture_mode,
           description_hash = @description_hash,
           has_body = @has_body,
           posted_at = COALESCE(@posted_at, posted_at),
           last_seen_at = @last_seen_at,
           closed_at = NULL,
           updated_at = @updated_at
         WHERE id = @id`,
      )
      .run({
        id: postingId,
        source_job_id: toDb(normalized.sourceJobId),
        source_url: normalized.sourceUrl,
        canonical_url: toDb(normalized.canonicalUrl),
        apply_url: toDb(normalized.applyUrl),
        application_system: toDb(normalized.applicationSystem),
        location_text: toDb(normalized.locationText),
        capture_mode: options.captureMode,
        description_hash: normalized.descriptionHash,
        has_body: options.hasBody ? 1 : 0,
        last_seen_at: seenAt,
        posted_at: toDb(normalized.postedAt),
        updated_at: nowIso(),
      });
  }

  /**
   * Closes postings a source stopped advertising.
   *
   * Only ever called after a source run succeeded, so a failed fetch cannot
   * retire live roles (architecture.md §30).
   */
  closeMissing(sourceName: string, scanStartedAt: IsoTimestamp, closedAt: IsoTimestamp): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM source_postings
         WHERE source_name = ? AND closed_at IS NULL AND last_seen_at < ?`,
      )
      .all(sourceName, scanStartedAt) as { id: string }[];

    if (rows.length === 0) return [];

    const update = this.db.prepare('UPDATE source_postings SET closed_at = ?, updated_at = ? WHERE id = ?');
    const timestamp = nowIso();
    for (const row of rows) update.run(closedAt, timestamp, row.id);

    return rows.map((row) => row.id);
  }

  /** Job ids whose postings are now all closed, for lifecycle roll-up. */
  jobIdsWithAllPostingsClosed(postingIds: string[]): string[] {
    if (postingIds.length === 0) return [];

    const placeholders = postingIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT DISTINCT job_id FROM source_postings
         WHERE id IN (${placeholders})
           AND job_id NOT IN (SELECT job_id FROM source_postings WHERE closed_at IS NULL)`,
      )
      .all(...postingIds) as { job_id: string }[];

    return rows.map((row) => row.job_id);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM source_postings').get() as { n: number };
    return row.n;
  }
}
