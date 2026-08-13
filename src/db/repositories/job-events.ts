import type { JobEventType, JobSeenEvent, SourceType } from '../../core/types.js';
import { randomId } from '../../util/hash.js';
import type { IsoTimestamp } from '../../util/time.js';
import type { Database } from '../database.js';
import { fromDb, toDb } from './row-mapping.js';

interface EventRow {
  id: string;
  job_id: string;
  seen_at: string;
  source_type: string;
  source_job_id: string | null;
  url: string;
  event_type: string;
  detail: string | null;
  scan_id: string | null;
}

function mapRow(row: EventRow): JobSeenEvent {
  return {
    id: row.id,
    jobId: row.job_id,
    seenAt: row.seen_at,
    sourceType: row.source_type as SourceType,
    sourceJobId: fromDb(row.source_job_id),
    url: row.url,
    eventType: row.event_type as JobEventType,
    detail: fromDb(row.detail),
  };
}

export interface EventInput {
  jobId: string;
  seenAt: IsoTimestamp;
  sourceType: SourceType;
  sourceJobId: string | undefined;
  url: string;
  eventType: JobEventType;
  detail: string | undefined;
  scanId: string | undefined;
}

/** Append-only lifecycle history for a job. */
export class JobEventRepository {
  constructor(private readonly db: Database) {}

  insert(input: EventInput): JobSeenEvent {
    const id = randomId('evt');
    this.db
      .prepare(
        `INSERT INTO job_seen_events (id, job_id, seen_at, source_type, source_job_id, url, event_type, detail, scan_id)
         VALUES (@id, @job_id, @seen_at, @source_type, @source_job_id, @url, @event_type, @detail, @scan_id)`,
      )
      .run({
        id,
        job_id: input.jobId,
        seen_at: input.seenAt,
        source_type: input.sourceType,
        source_job_id: toDb(input.sourceJobId),
        url: input.url,
        event_type: input.eventType,
        detail: toDb(input.detail),
        scan_id: toDb(input.scanId),
      });

    const row = this.db.prepare('SELECT * FROM job_seen_events WHERE id = ?').get(id) as EventRow;
    return mapRow(row);
  }

  listForJob(jobId: string): JobSeenEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM job_seen_events WHERE job_id = ? ORDER BY seen_at, rowid')
      .all(jobId) as EventRow[];
    return rows.map(mapRow);
  }

  listRepostsForJob(jobId: string): JobSeenEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM job_seen_events WHERE job_id = ? AND event_type = 'reposted' ORDER BY seen_at")
      .all(jobId) as EventRow[];
    return rows.map(mapRow);
  }
}
