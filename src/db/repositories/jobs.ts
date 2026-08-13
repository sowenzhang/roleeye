import type { EmploymentType, Job, SalaryPeriod, SourceType, WorkArrangement } from '../../core/types.js';
import type { NormalizedJob } from '../../normalize/job.js';
import { deriveJobId } from '../../util/hash.js';
import { nowIso, type IsoTimestamp } from '../../util/time.js';
import type { Database } from '../database.js';
import { fromDb, toDb } from './row-mapping.js';

interface JobRow {
  id: string;
  company_id: string;
  title: string;
  normalized_title: string;
  level: string | null;
  employment_type: string;
  work_arrangement: string;
  location_text: string | null;
  country: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: string | null;
  source_type: string;
  source_name: string | null;
  source_job_id: string | null;
  source_url: string;
  canonical_url: string | null;
  apply_url: string | null;
  application_system: string | null;
  identity_key: string;
  identity_tier: string;
  fingerprint: string;
  description_text: string;
  description_hash: string;
  posted_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  department: string | null;
  team: string | null;
  capture_mode: string;
  in_scope: number;
  scope_reason: string | null;
}

export interface JobWithCompany extends Job {
  companyName: string;
  sourceName: string | undefined;
  applicationSystem: string | undefined;
  department: string | undefined;
  team: string | undefined;
  captureMode: string;
  inScope: boolean;
  scopeReason: string | undefined;
}

function mapRow(row: JobRow & { company_name?: string }): JobWithCompany {
  return {
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name ?? '',
    title: row.title,
    normalizedTitle: row.normalized_title,
    level: fromDb(row.level),
    employmentType: row.employment_type as EmploymentType,
    workArrangement: row.work_arrangement as WorkArrangement,
    locationText: fromDb(row.location_text),
    country: fromDb(row.country),
    salaryMin: fromDb(row.salary_min),
    salaryMax: fromDb(row.salary_max),
    salaryCurrency: fromDb(row.salary_currency),
    salaryPeriod: fromDb(row.salary_period) as SalaryPeriod | undefined,
    sourceType: row.source_type as SourceType,
    sourceName: fromDb(row.source_name),
    sourceJobId: fromDb(row.source_job_id),
    sourceUrl: row.source_url,
    canonicalUrl: fromDb(row.canonical_url),
    applyUrl: fromDb(row.apply_url),
    applicationSystem: fromDb(row.application_system),
    identityKey: row.identity_key,
    descriptionText: row.description_text,
    descriptionHash: row.description_hash,
    fingerprint: row.fingerprint,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    closedAt: fromDb(row.closed_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    department: fromDb(row.department),
    team: fromDb(row.team),
    captureMode: row.capture_mode ?? 'scoped',
    inScope: row.in_scope !== 0,
    scopeReason: fromDb(row.scope_reason),
  };
}

const SELECT_WITH_COMPANY = `
  SELECT jobs.*, companies.name AS company_name
  FROM jobs
  JOIN companies ON companies.id = jobs.company_id`;

export interface JobListFilters {
  company?: string | undefined;
  titleContains?: string | undefined;
  sourceType?: string | undefined;
  country?: string | undefined;
  department?: string | undefined;
  seenSince?: IsoTimestamp | undefined;
  includeClosed?: boolean | undefined;
  /** Defaults to in-scope only; out-of-scope rows are history, not results. */
  inScope?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface CaptureContext {
  captureMode: string;
  inScope: boolean;
  scopeReason: string | undefined;
}

export class JobRepository {
  constructor(private readonly db: Database) {}

  findById(id: string): JobWithCompany | undefined {
    const row = this.db.prepare(`${SELECT_WITH_COMPANY} WHERE jobs.id = ?`).get(id) as JobRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  /** Supports short IDs on the command line, e.g. `roleeye show a1b2c3`. */
  findByIdPrefix(prefix: string): JobWithCompany[] {
    const rows = this.db
      .prepare(`${SELECT_WITH_COMPANY} WHERE jobs.id LIKE ? ORDER BY jobs.last_seen_at DESC LIMIT 10`)
      .all(`${prefix}%`) as JobRow[];
    return rows.map(mapRow);
  }

  findByIdentityKey(identityKey: string): JobWithCompany | undefined {
    const row = this.db.prepare(`${SELECT_WITH_COMPANY} WHERE jobs.identity_key = ?`).get(identityKey) as
      | JobRow
      | undefined;
    return row ? mapRow(row) : undefined;
  }

  findByCanonicalUrl(url: string): JobWithCompany | undefined {
    const row = this.db
      .prepare(`${SELECT_WITH_COMPANY} WHERE jobs.canonical_url = ? OR jobs.apply_url = ? LIMIT 1`)
      .get(url, url) as JobRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  findByFingerprint(fingerprint: string): JobWithCompany | undefined {
    const row = this.db.prepare(`${SELECT_WITH_COMPANY} WHERE jobs.fingerprint = ? LIMIT 1`).get(fingerprint) as
      | JobRow
      | undefined;
    return row ? mapRow(row) : undefined;
  }

  insert(
    normalized: NormalizedJob,
    companyId: string,
    seenAt: IsoTimestamp,
    capture: CaptureContext = { captureMode: 'scoped', inScope: true, scopeReason: undefined },
  ): JobWithCompany {
    const id = deriveJobId(normalized.identityKey);
    const timestamp = nowIso();

    this.db
      .prepare(
        `INSERT INTO jobs (
           id, company_id, title, normalized_title, level, employment_type, work_arrangement,
           location_text, country, salary_min, salary_max, salary_currency, salary_period,
           source_type, source_name, source_job_id, source_url, canonical_url, apply_url,
           application_system, identity_key, identity_tier, fingerprint, description_text,
           description_hash, posted_at, first_seen_at, last_seen_at, closed_at, created_at, updated_at,
           department, team, capture_mode, in_scope, scope_reason
         ) VALUES (
           @id, @company_id, @title, @normalized_title, @level, @employment_type, @work_arrangement,
           @location_text, @country, @salary_min, @salary_max, @salary_currency, @salary_period,
           @source_type, @source_name, @source_job_id, @source_url, @canonical_url, @apply_url,
           @application_system, @identity_key, @identity_tier, @fingerprint, @description_text,
           @description_hash, @posted_at, @first_seen_at, @last_seen_at, NULL, @created_at, @updated_at,
           @department, @team, @capture_mode, @in_scope, @scope_reason
         )`,
      )
      .run({
        id,
        company_id: companyId,
        title: normalized.title,
        normalized_title: normalized.normalizedTitle,
        level: toDb(normalized.level),
        employment_type: normalized.employmentType,
        work_arrangement: normalized.workArrangement,
        location_text: toDb(normalized.locationText),
        country: toDb(normalized.country),
        salary_min: toDb(normalized.salaryMin),
        salary_max: toDb(normalized.salaryMax),
        salary_currency: toDb(normalized.salaryCurrency),
        salary_period: toDb(normalized.salaryPeriod),
        source_type: normalized.sourceType,
        source_name: normalized.sourceName,
        source_job_id: toDb(normalized.sourceJobId),
        source_url: normalized.sourceUrl,
        canonical_url: toDb(normalized.canonicalUrl),
        apply_url: toDb(normalized.applyUrl),
        application_system: toDb(normalized.applicationSystem),
        identity_key: normalized.identityKey,
        identity_tier: normalized.identityTier,
        fingerprint: normalized.fingerprint,
        description_text: normalized.descriptionText,
        description_hash: normalized.descriptionHash,
        posted_at: toDb(normalized.postedAt),
        first_seen_at: seenAt,
        last_seen_at: seenAt,
        created_at: timestamp,
        updated_at: timestamp,
        department: toDb(normalized.department),
        team: toDb(normalized.team),
        capture_mode: capture.captureMode,
        in_scope: capture.inScope ? 1 : 0,
        scope_reason: toDb(capture.scopeReason),
      });

    const inserted = this.findById(id);
    if (!inserted) throw new Error(`failed to read back inserted job ${id}`);
    return inserted;
  }

  /**
   * Updates a job we have seen before. `first_seen_at` is never touched and
   * nothing is deleted, per the preserve-history rule.
   */
  markSeen(
    jobId: string,
    normalized: NormalizedJob,
    seenAt: IsoTimestamp,
    options: { updateContent: boolean } & Partial<CaptureContext>,
  ): void {
    const scopeFields = {
      capture_mode: options.captureMode ?? null,
      in_scope: options.inScope === undefined ? null : options.inScope ? 1 : 0,
      scope_reason: toDb(options.scopeReason),
    };

    if (!options.updateContent) {
      this.db
        .prepare(
          `UPDATE jobs SET
             last_seen_at = @last_seen_at,
             closed_at = NULL,
             updated_at = @updated_at,
             capture_mode = COALESCE(@capture_mode, capture_mode),
             in_scope = COALESCE(@in_scope, in_scope),
             scope_reason = @scope_reason
           WHERE id = @id`,
        )
        .run({ id: jobId, last_seen_at: seenAt, updated_at: nowIso(), ...scopeFields });
      return;
    }

    this.db
      .prepare(
        `UPDATE jobs SET
           title = @title,
           normalized_title = @normalized_title,
           level = @level,
           employment_type = @employment_type,
           work_arrangement = @work_arrangement,
           location_text = @location_text,
           country = @country,
           salary_min = @salary_min,
           salary_max = @salary_max,
           salary_currency = @salary_currency,
           salary_period = @salary_period,
           source_url = @source_url,
           canonical_url = @canonical_url,
           apply_url = @apply_url,
           application_system = @application_system,
           source_job_id = COALESCE(@source_job_id, source_job_id),
           fingerprint = @fingerprint,
           description_text = @description_text,
           description_hash = @description_hash,
           department = COALESCE(@department, department),
           team = COALESCE(@team, team),
           capture_mode = COALESCE(@capture_mode, capture_mode),
           in_scope = COALESCE(@in_scope, in_scope),
           scope_reason = @scope_reason,
           last_seen_at = @last_seen_at,
           closed_at = NULL,
           updated_at = @updated_at
         WHERE id = @id`,
      )
      .run({
        id: jobId,
        title: normalized.title,
        normalized_title: normalized.normalizedTitle,
        level: toDb(normalized.level),
        employment_type: normalized.employmentType,
        work_arrangement: normalized.workArrangement,
        location_text: toDb(normalized.locationText),
        country: toDb(normalized.country),
        salary_min: toDb(normalized.salaryMin),
        salary_max: toDb(normalized.salaryMax),
        salary_currency: toDb(normalized.salaryCurrency),
        salary_period: toDb(normalized.salaryPeriod),
        source_url: normalized.sourceUrl,
        canonical_url: toDb(normalized.canonicalUrl),
        apply_url: toDb(normalized.applyUrl),
        application_system: toDb(normalized.applicationSystem),
        source_job_id: toDb(normalized.sourceJobId),
        fingerprint: normalized.fingerprint,
        description_text: normalized.descriptionText,
        description_hash: normalized.descriptionHash,
        last_seen_at: seenAt,
        updated_at: nowIso(),
        department: toDb(normalized.department),
        team: toDb(normalized.team),
        ...scopeFields,
      });
  }

  list(filters: JobListFilters = {}): JobWithCompany[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (!filters.includeClosed) clauses.push('jobs.closed_at IS NULL');
    if (filters.company) {
      clauses.push('companies.normalized_name LIKE @company');
      params['company'] = `%${filters.company.toLowerCase()}%`;
    }
    if (filters.titleContains) {
      clauses.push('jobs.normalized_title LIKE @title');
      params['title'] = `%${filters.titleContains.toLowerCase()}%`;
    }
    if (filters.sourceType) {
      clauses.push('jobs.source_type = @sourceType');
      params['sourceType'] = filters.sourceType;
    }
    if (filters.country) {
      clauses.push('jobs.country = @country');
      params['country'] = filters.country;
    }
    if (filters.department) {
      clauses.push('(LOWER(jobs.department) LIKE @department OR LOWER(jobs.team) LIKE @department)');
      params['department'] = `%${filters.department.toLowerCase()}%`;
    }
    if (filters.inScope !== undefined) {
      clauses.push('jobs.in_scope = @inScope');
      params['inScope'] = filters.inScope ? 1 : 0;
    }
    if (filters.seenSince) {
      clauses.push('jobs.last_seen_at >= @seenSince');
      params['seenSince'] = filters.seenSince;
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    params['limit'] = filters.limit ?? 50;
    params['offset'] = filters.offset ?? 0;

    const rows = this.db
      .prepare(`${SELECT_WITH_COMPANY}${where} ORDER BY jobs.last_seen_at DESC, jobs.title LIMIT @limit OFFSET @offset`)
      .all(params) as JobRow[];

    return rows.map(mapRow);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number };
    return row.n;
  }
}
