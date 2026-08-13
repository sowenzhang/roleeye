import type { AppConfig } from '../config/load.js';
import type { CaptureMode, SourceConfig } from '../config/schema.js';
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
import { scopeFromConfig, evaluateScope, type EffectiveScope } from './scope.js';
import { normalizeDiscoveredJob } from '../normalize/job.js';
import type { HttpClient } from './source-adapter.js';

export interface SourceScanSummary {
  sourceName: string;
  sourceType: string;
  captureMode: string;
  status: 'ok' | 'failed';
  fetched: number;
  outOfScope: number;
  capped: number;
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
  totals: { fetched: number; new: number; changed: number; reposted: number; unchanged: number; outOfScope: number };
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

export interface ResolvedSourcePlan {
  source: SourceConfig;
  captureMode: CaptureMode;
  scope: EffectiveScope;
}

/** Combines global discovery settings with per-source overrides. */
export function planSource(config: AppConfig, source: SourceConfig): ResolvedSourcePlan {
  return {
    source,
    captureMode: source.capture_mode ?? config.sources.discovery.capture_mode,
    scope: scopeFromConfig(config.sources, source.scope),
  };
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
    const plan = planSource(config, source);

    const summary: SourceScanSummary = {
      sourceName: source.name,
      sourceType: source.type,
      captureMode: plan.captureMode,
      status: 'ok',
      fetched: 0,
      outOfScope: 0,
      capped: 0,
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

      // A board that suddenly publishes hundreds of roles should warn, not
      // silently flood the database or the evaluation queue.
      const cap = plan.scope.maxNewPerSourcePerScan;
      let candidates = discovered;
      if (cap !== undefined && discovered.length > cap) {
        candidates = discovered.slice(0, cap);
        summary.capped = discovered.length - cap;
        sourceLogger.warn('source exceeded its per-scan cap', {
          fetched: discovered.length,
          cap,
          skipped: summary.capped,
        });
      }

      if (!options.dryRun) {
        const seenAt = nowIso();
        const results = withTransaction(db, () =>
          candidates.map((job) =>
            ingestJob(repos, job, {
              seenAt,
              scanId,
              repostGapDays: config.sources.dedupe.repost_gap_days,
              captureMode: plan.captureMode,
              scope: plan.scope,
            }),
          ),
        );
        tally(summary, results);
      } else {
        summary.outOfScope = countOutOfScope(candidates, plan);
      }

      sourceLogger.info('source scanned', {
        captureMode: plan.captureMode,
        fetched: summary.fetched,
        outOfScope: summary.outOfScope,
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
          recordsOutOfScope: summary.outOfScope,
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
      outOfScope: sum(summaries, 'outOfScope'),
    },
  };
}

/** An out-of-scope posting in `scoped` mode is skipped, so ingest returns nothing. */
function tally(summary: SourceScanSummary, results: Array<IngestResult | undefined>): void {
  for (const result of results) {
    if (!result) {
      summary.outOfScope += 1;
      continue;
    }
    if (!result.inScope) summary.outOfScope += 1;
    summary[result.outcome] += 1;
  }
}

function countOutOfScope(candidates: DiscoveredJob[], plan: ResolvedSourcePlan): number {
  return candidates.filter((job) => {
    const normalized = normalizeDiscoveredJob(job);
    return !evaluateScope(
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
      plan.scope,
    ).inScope;
  }).length;
}

function sum(summaries: SourceScanSummary[], key: keyof SourceScanSummary): number {
  return summaries.reduce((total, entry) => total + (typeof entry[key] === 'number' ? (entry[key] as number) : 0), 0);
}
