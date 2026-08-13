import type { AppConfig } from '../config/load.js';
import type { SourceConfig } from '../config/schema.js';
import type { DiscoveredJob } from '../core/types.js';
import type { Database } from '../db/database.js';
import { withTransaction } from '../db/database.js';
import type { Repositories } from '../db/repositories/index.js';
import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { nowIso } from '../util/time.js';
import { createHttpClient } from './http.js';
import { ingestJob, type IngestResult } from './ingest.js';
import { getAdapter } from './registry.js';
import type { HttpClient } from './source-adapter.js';

export interface SourceScanSummary {
  sourceName: string;
  sourceType: string;
  status: 'ok' | 'failed';
  fetched: number;
  filtered: number;
  new: number;
  changed: number;
  reposted: number;
  unchanged: number;
  error: string | undefined;
}

export interface ScanSummary {
  scanId: string;
  startedAt: string;
  finishedAt: string;
  status: 'ok' | 'warning' | 'failed';
  sources: SourceScanSummary[];
  totals: { fetched: number; new: number; changed: number; reposted: number; unchanged: number };
}

export interface ScanOptions {
  config: AppConfig;
  db: Database;
  repos: Repositories;
  logger: Logger;
  /** Restrict the scan to specific source names or types. */
  only?: string[] | undefined;
  dryRun?: boolean | undefined;
  http?: HttpClient | undefined;
}

/** Cheap title filters keep obviously irrelevant postings out of the pipeline. */
export function passesDiscoveryFilters(title: string, filters: AppConfig['sources']['discovery_filters']): boolean {
  const lower = title.toLowerCase();

  if (filters.title_exclude.some((term) => lower.includes(term.toLowerCase()))) return false;
  if (filters.title_include.length === 0) return true;

  return filters.title_include.some((term) => lower.includes(term.toLowerCase()));
}

function selectSources(config: AppConfig, only: string[] | undefined): SourceConfig[] {
  const enabled = config.sources.sources.filter((source) => source.enabled);
  if (!only || only.length === 0) return enabled;

  const wanted = new Set(only.map((value) => value.toLowerCase()));
  return enabled.filter((source) => wanted.has(source.name.toLowerCase()) || wanted.has(source.type));
}

/**
 * Runs every enabled source.
 *
 * One provider failing must never abort the scan or cause other jobs to be
 * treated as closed (architecture.md §30).
 */
export async function runScan(options: ScanOptions): Promise<ScanSummary> {
  const { config, db, repos, logger } = options;
  const startedAt = nowIso();
  const sources = selectSources(config, options.only);

  const http =
    options.http ??
    createHttpClient({
      userAgent: config.sources.defaults.user_agent,
      timeoutMs: config.sources.defaults.timeout_ms,
      delayMs: config.sources.defaults.request_delay_ms,
      logger,
    });

  const scanId = options.dryRun ? `scan_dry_${Date.now().toString(16)}` : repos.scans.startScan();
  const summaries: SourceScanSummary[] = [];

  for (const source of sources) {
    const adapter = getAdapter(source.type);
    const runId = options.dryRun ? undefined : repos.scans.startSourceRun(scanId, source.name, source.type);
    const sourceLogger = logger.child({ source: source.name });

    const summary: SourceScanSummary = {
      sourceName: source.name,
      sourceType: source.type,
      status: 'ok',
      fetched: 0,
      filtered: 0,
      new: 0,
      changed: 0,
      reposted: 0,
      unchanged: 0,
      error: undefined,
    };

    if (!adapter) {
      summary.status = 'failed';
      summary.error = `no adapter registered for source type "${source.type}"`;
      sourceLogger.warn('source skipped', { reason: summary.error });
      if (runId) {
        repos.scans.finishSourceRun(runId, {
          status: 'failed',
          recordsSeen: 0,
          recordsNew: 0,
          recordsChanged: 0,
          error: summary.error,
        });
      }
      summaries.push(summary);
      continue;
    }

    try {
      const discovered: DiscoveredJob[] = await adapter.scan(source as never, { http, logger: sourceLogger });
      summary.fetched = discovered.length;

      const kept = discovered.filter((job) => passesDiscoveryFilters(job.title, config.sources.discovery_filters));
      summary.filtered = discovered.length - kept.length;

      if (!options.dryRun) {
        const seenAt = nowIso();
        const results = withTransaction(db, () =>
          kept.map((job) =>
            ingestJob(repos, job, {
              seenAt,
              scanId,
              repostGapDays: config.sources.dedupe.repost_gap_days,
            }),
          ),
        );
        tally(summary, results);
      }

      sourceLogger.info('source scanned', {
        fetched: summary.fetched,
        filtered: summary.filtered,
        new: summary.new,
        changed: summary.changed,
        reposted: summary.reposted,
      });

      if (runId) {
        repos.scans.finishSourceRun(runId, {
          status: 'ok',
          recordsSeen: summary.fetched,
          recordsNew: summary.new,
          recordsChanged: summary.changed + summary.reposted,
        });
      }
    } catch (error) {
      summary.status = 'failed';
      summary.error = errorMessage(error);
      sourceLogger.error('source failed', { error: summary.error });

      if (runId) {
        repos.scans.finishSourceRun(runId, {
          status: 'failed',
          recordsSeen: summary.fetched,
          recordsNew: summary.new,
          recordsChanged: summary.changed,
          error: summary.error,
        });
      }
    }

    summaries.push(summary);
  }

  const failed = summaries.filter((entry) => entry.status === 'failed').length;
  const status: ScanSummary['status'] =
    failed === 0 ? 'ok' : failed === summaries.length && summaries.length > 0 ? 'failed' : 'warning';

  if (!options.dryRun) {
    repos.scans.finishScan(scanId, status, failed > 0 ? `${failed} source(s) failed` : undefined);
  }

  return {
    scanId,
    startedAt,
    finishedAt: nowIso(),
    status,
    sources: summaries,
    totals: {
      fetched: sum(summaries, 'fetched'),
      new: sum(summaries, 'new'),
      changed: sum(summaries, 'changed'),
      reposted: sum(summaries, 'reposted'),
      unchanged: sum(summaries, 'unchanged'),
    },
  };
}

function tally(summary: SourceScanSummary, results: IngestResult[]): void {
  for (const result of results) {
    summary[result.outcome] += 1;
  }
}

function sum(summaries: SourceScanSummary[], key: keyof SourceScanSummary): number {
  return summaries.reduce((total, entry) => total + (typeof entry[key] === 'number' ? (entry[key] as number) : 0), 0);
}
