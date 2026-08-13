import type { SourceRun, SourceRunStatus, SourceType } from '../../core/types.js';
import { randomId } from '../../util/hash.js';
import { nowIso } from '../../util/time.js';
import type { Database } from '../database.js';
import { fromDb, toDb } from './row-mapping.js';

interface SourceRunRow {
  id: string;
  scan_id: string;
  source_name: string;
  source_type: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  records_seen: number;
  records_new: number;
  records_changed: number;
  error: string | null;
}

function mapRow(row: SourceRunRow): SourceRun {
  return {
    id: row.id,
    scanId: row.scan_id,
    sourceName: row.source_name,
    sourceType: row.source_type as SourceType,
    startedAt: row.started_at,
    finishedAt: fromDb(row.finished_at),
    status: row.status as SourceRunStatus,
    recordsSeen: row.records_seen,
    recordsNew: row.records_new,
    recordsChanged: row.records_changed,
    error: fromDb(row.error),
  };
}

export interface SourceRunResult {
  status: SourceRunStatus;
  recordsSeen: number;
  recordsNew: number;
  recordsChanged: number;
  recordsOutOfScope?: number | undefined;
  error?: string | undefined;
}

/**
 * Persists scan history so a failing provider is visible later, and so we never
 * conclude a job closed because one source run failed.
 */
export class ScanRepository {
  constructor(private readonly db: Database) {}

  startScan(): string {
    const id = randomId('scan');
    this.db
      .prepare("INSERT INTO scans (id, started_at, finished_at, status, notes) VALUES (?, ?, NULL, 'running', NULL)")
      .run(id, nowIso());
    return id;
  }

  finishScan(scanId: string, status: 'ok' | 'warning' | 'failed', notes?: string): void {
    this.db
      .prepare('UPDATE scans SET finished_at = ?, status = ?, notes = ? WHERE id = ?')
      .run(nowIso(), status, toDb(notes), scanId);
  }

  startSourceRun(scanId: string, sourceName: string, sourceType: SourceType): string {
    const id = randomId('run');
    this.db
      .prepare(
        `INSERT INTO source_runs (id, scan_id, source_name, source_type, started_at, status)
         VALUES (?, ?, ?, ?, ?, 'running')`,
      )
      .run(id, scanId, sourceName, sourceType, nowIso());
    return id;
  }

  finishSourceRun(runId: string, result: SourceRunResult): void {
    this.db
      .prepare(
        `UPDATE source_runs SET
           finished_at = @finished_at,
           status = @status,
           records_seen = @records_seen,
           records_new = @records_new,
           records_changed = @records_changed,
           records_out_of_scope = @records_out_of_scope,
           error = @error
         WHERE id = @id`,
      )
      .run({
        id: runId,
        finished_at: nowIso(),
        status: result.status,
        records_seen: result.recordsSeen,
        records_new: result.recordsNew,
        records_changed: result.recordsChanged,
        records_out_of_scope: result.recordsOutOfScope ?? 0,
        error: toDb(result.error),
      });
  }

  listRunsForScan(scanId: string): SourceRun[] {
    const rows = this.db
      .prepare('SELECT * FROM source_runs WHERE scan_id = ? ORDER BY started_at')
      .all(scanId) as SourceRunRow[];
    return rows.map(mapRow);
  }

  listRecentRuns(limit = 20): SourceRun[] {
    const rows = this.db
      .prepare('SELECT * FROM source_runs ORDER BY started_at DESC LIMIT ?')
      .all(limit) as SourceRunRow[];
    return rows.map(mapRow);
  }
}
