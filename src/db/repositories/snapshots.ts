import type { JobSnapshot } from '../../core/types.js';
import { randomId } from '../../util/hash.js';
import type { IsoTimestamp } from '../../util/time.js';
import type { Database } from '../database.js';
import { fromDb, toDb } from './row-mapping.js';

interface SnapshotRow {
  id: string;
  job_id: string;
  captured_at: string;
  source_url: string;
  raw_payload: string | null;
  normalized_description: string;
  description_hash: string;
}

function mapRow(row: SnapshotRow): JobSnapshot {
  return {
    id: row.id,
    jobId: row.job_id,
    capturedAt: row.captured_at,
    sourceUrl: row.source_url,
    rawPayload: fromDb(row.raw_payload),
    normalizedDescription: row.normalized_description,
    descriptionHash: row.description_hash,
  };
}

export interface SnapshotInput {
  jobId: string;
  capturedAt: IsoTimestamp;
  sourceUrl: string;
  rawPayload: string | undefined;
  normalizedDescription: string;
  descriptionHash: string;
}

export class SnapshotRepository {
  constructor(private readonly db: Database) {}

  /**
   * Stores a capture of the posting. Identical content is not stored twice, but
   * an existing snapshot is never overwritten.
   */
  insertIfNew(input: SnapshotInput): JobSnapshot | undefined {
    const existing = this.db
      .prepare('SELECT id FROM job_snapshots WHERE job_id = ? AND description_hash = ?')
      .get(input.jobId, input.descriptionHash) as { id: string } | undefined;

    if (existing) return undefined;

    const id = randomId('snap');
    this.db
      .prepare(
        `INSERT INTO job_snapshots (
           id, job_id, captured_at, source_url, raw_payload, raw_html_path, normalized_description, description_hash
         ) VALUES (@id, @job_id, @captured_at, @source_url, @raw_payload, NULL, @normalized_description, @description_hash)`,
      )
      .run({
        id,
        job_id: input.jobId,
        captured_at: input.capturedAt,
        source_url: input.sourceUrl,
        raw_payload: toDb(input.rawPayload),
        normalized_description: input.normalizedDescription,
        description_hash: input.descriptionHash,
      });

    const row = this.db.prepare('SELECT * FROM job_snapshots WHERE id = ?').get(id) as SnapshotRow;
    return mapRow(row);
  }

  listForJob(jobId: string): JobSnapshot[] {
    const rows = this.db
      .prepare('SELECT * FROM job_snapshots WHERE job_id = ? ORDER BY captured_at')
      .all(jobId) as SnapshotRow[];
    return rows.map(mapRow);
  }

  countForJob(jobId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM job_snapshots WHERE job_id = ?').get(jobId) as {
      n: number;
    };
    return row.n;
  }
}
