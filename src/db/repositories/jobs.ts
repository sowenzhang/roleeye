import type { EmploymentType, SalaryPeriod, WorkArrangement } from '../../core/types.js';
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
  department: string | null;
  team: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: string | null;
  description_text: string;
  description_hash: string;
  has_body: number;
  fingerprint: string;
  cluster_key: string | null;
  in_scope: number;
  scope_reason: string | null;
  posted_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A logical role. Source identity lives on `source_postings`. */
export interface JobRecord {
  id: string;
  companyId: string;
  companyName: string;
  title: string;
  normalizedTitle: string;
  level: string | undefined;
  employmentType: EmploymentType;
  workArrangement: WorkArrangement;
  locationText: string | undefined;
  country: string | undefined;
  department: string | undefined;
  team: string | undefined;
  salaryMin: number | undefined;
  salaryMax: number | undefined;
  salaryCurrency: string | undefined;
  salaryPeriod: SalaryPeriod | undefined;
  descriptionText: string;
  descriptionHash: string;
  hasBody: boolean;
  fingerprint: string;
  clusterKey: string | undefined;
  inScope: boolean;
  scopeReason: string | undefined;
  postedAt: IsoTimestamp | undefined;
  firstSeenAt: IsoTimestamp;
  lastSeenAt: IsoTimestamp;
  closedAt: IsoTimestamp | undefined;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

function mapRow(row: JobRow & { company_name?: string }): JobRecord {
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
    department: fromDb(row.department),
    team: fromDb(row.team),
    salaryMin: fromDb(row.salary_min),
    salaryMax: fromDb(row.salary_max),
    salaryCurrency: fromDb(row.salary_currency),
    salaryPeriod: fromDb(row.salary_period) as SalaryPeriod | undefined,
    descriptionText: row.description_text,
    descriptionHash: row.description_hash,
    hasBody: row.has_body !== 0,
    fingerprint: row.fingerprint,
    clusterKey: fromDb(row.cluster_key),
    inScope: row.in_scope !== 0,
    scopeReason: fromDb(row.scope_reason),
    postedAt: fromDb(row.posted_at),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    closedAt: fromDb(row.closed_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
  sourceName?: string | undefined;
  country?: string | undefined;
  department?: string | undefined;
  seenSince?: IsoTimestamp | undefined;
  includeClosed?: boolean | undefined;
  /** Defaults to in-scope only; out-of-scope rows are history, not results. */
  inScope?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface ScopeState {
  inScope: boolean;
  scopeReason: string | undefined;
}

export class JobRepository {
  constructor(private readonly db: Database) {}

  findById(id: string): JobRecord | undefined {
    const row = this.db.prepare(`${SELECT_WITH_COMPANY} WHERE jobs.id = ?`).get(id) as JobRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  /** Supports short IDs on the command line, e.g. `roleeye show a1b2c3`. */
  findByIdPrefix(prefix: string): JobRecord[] {
    const rows = this.db
      .prepare(`${SELECT_WITH_COMPANY} WHERE jobs.id LIKE ? ORDER BY jobs.last_seen_at DESC LIMIT 10`)
      .all(`${prefix}%`) as JobRow[];
    return rows.map(mapRow);
  }

  /**
   * Finds the logical role a posting belongs to.
   *
   * Clustering requires an identical body under the same company, so two roles
   * never merge on title similarity alone (architecture.md §12).
   */
  findByClusterKey(companyId: string, clusterKey: string): JobRecord | undefined {
    const row = this.db
      .prepare(`${SELECT_WITH_COMPANY} WHERE jobs.company_id = ? AND jobs.cluster_key = ? LIMIT 1`)
      .get(companyId, clusterKey) as JobRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  findByFingerprint(fingerprint: string): JobRecord | undefined {
    const row = this.db.prepare(`${SELECT_WITH_COMPANY} WHERE jobs.fingerprint = ? LIMIT 1`).get(fingerprint) as
      | JobRow
      | undefined;
    return row ? mapRow(row) : undefined;
  }

  insert(normalized: NormalizedJob, companyId: string, seenAt: IsoTimestamp, scope: ScopeState): JobRecord {
    const id = deriveJobId(normalized.identityKey);
    const timestamp = nowIso();
    const hasBody = normalized.descriptionText.length > 0;

    this.db
      .prepare(
        `INSERT INTO jobs (
           id, company_id, title, normalized_title, level, employment_type, work_arrangement,
           location_text, country, department, team, salary_min, salary_max, salary_currency,
           salary_period, description_text, description_hash, has_body, fingerprint, cluster_key,
           in_scope, scope_reason, posted_at, first_seen_at, last_seen_at, closed_at,
           created_at, updated_at
         ) VALUES (
           @id, @company_id, @title, @normalized_title, @level, @employment_type, @work_arrangement,
           @location_text, @country, @department, @team, @salary_min, @salary_max, @salary_currency,
           @salary_period, @description_text, @description_hash, @has_body, @fingerprint, @cluster_key,
           @in_scope, @scope_reason, @posted_at, @first_seen_at, @last_seen_at, NULL,
           @created_at, @updated_at
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
        department: toDb(normalized.department),
        team: toDb(normalized.team),
        salary_min: toDb(normalized.salaryMin),
        salary_max: toDb(normalized.salaryMax),
        salary_currency: toDb(normalized.salaryCurrency),
        salary_period: toDb(normalized.salaryPeriod),
        description_text: normalized.descriptionText,
        description_hash: normalized.descriptionHash,
        has_body: hasBody ? 1 : 0,
        fingerprint: normalized.fingerprint,
        cluster_key: toDb(normalized.clusterKey),
        in_scope: scope.inScope ? 1 : 0,
        scope_reason: toDb(scope.scopeReason),
        posted_at: toDb(normalized.postedAt),
        first_seen_at: seenAt,
        last_seen_at: seenAt,
        created_at: timestamp,
        updated_at: timestamp,
      });

    const inserted = this.findById(id);
    if (!inserted) throw new Error(`failed to read back inserted job ${id}`);
    return inserted;
  }

  /**
   * Records an observation of a known role.
   *
   * Content is only ever replaced by content: an observation carrying no body —
   * a `history` source, or a metadata-only refresh — updates timestamps and
   * scope but never erases a description we already hold.
   */
  markSeen(
    jobId: string,
    normalized: NormalizedJob,
    seenAt: IsoTimestamp,
    options: { updateContent: boolean; scope: ScopeState },
  ): void {
    const hasBody = normalized.descriptionText.length > 0;

    if (!options.updateContent || !hasBody) {
      this.db
        .prepare(
          `UPDATE jobs SET
             last_seen_at = @last_seen_at,
             closed_at = NULL,
             in_scope = @in_scope,
             scope_reason = @scope_reason,
             -- Backfills rows migrated from before clustering existed, so they
             -- can still be recognised when another source lists the same role.
             cluster_key = COALESCE(cluster_key, @cluster_key),
             updated_at = @updated_at
           WHERE id = @id`,
        )
        .run({
          id: jobId,
          last_seen_at: seenAt,
          in_scope: options.scope.inScope ? 1 : 0,
          scope_reason: toDb(options.scope.scopeReason),
          cluster_key: toDb(normalized.clusterKey),
          updated_at: nowIso(),
        });
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
           department = COALESCE(@department, department),
           team = COALESCE(@team, team),
           salary_min = @salary_min,
           salary_max = @salary_max,
           salary_currency = @salary_currency,
           salary_period = @salary_period,
           description_text = @description_text,
           description_hash = @description_hash,
           has_body = 1,
           fingerprint = @fingerprint,
           cluster_key = COALESCE(@cluster_key, cluster_key),
           in_scope = @in_scope,
           scope_reason = @scope_reason,
           posted_at = COALESCE(@posted_at, posted_at),
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
        department: toDb(normalized.department),
        team: toDb(normalized.team),
        salary_min: toDb(normalized.salaryMin),
        salary_max: toDb(normalized.salaryMax),
        salary_currency: toDb(normalized.salaryCurrency),
        salary_period: toDb(normalized.salaryPeriod),
        description_text: normalized.descriptionText,
        description_hash: normalized.descriptionHash,
        fingerprint: normalized.fingerprint,
        cluster_key: toDb(normalized.clusterKey),
        in_scope: options.scope.inScope ? 1 : 0,
        scope_reason: toDb(options.scope.scopeReason),
        posted_at: toDb(normalized.postedAt),
        last_seen_at: seenAt,
        updated_at: nowIso(),
      });
  }

  /** Marks a role closed once no source still advertises it. */
  close(jobId: string, closedAt: IsoTimestamp): void {
    this.db
      .prepare('UPDATE jobs SET closed_at = ?, updated_at = ? WHERE id = ? AND closed_at IS NULL')
      .run(closedAt, nowIso(), jobId);
  }

  list(filters: JobListFilters = {}): JobRecord[] {
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
      clauses.push(
        'EXISTS (SELECT 1 FROM source_postings p WHERE p.job_id = jobs.id AND p.source_type = @sourceType)',
      );
      params['sourceType'] = filters.sourceType;
    }
    if (filters.sourceName) {
      clauses.push(
        'EXISTS (SELECT 1 FROM source_postings p WHERE p.job_id = jobs.id AND p.source_name = @sourceName)',
      );
      params['sourceName'] = filters.sourceName;
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
