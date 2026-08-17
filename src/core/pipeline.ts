import type { AppConfig } from '../config/load.js';
import type { Database } from '../db/database.js';
import type { Repositories } from '../db/repositories/index.js';
import type { JobRecord } from '../db/repositories/jobs.js';
import type { Logger } from '../util/logger.js';
import { errorMessage } from '../util/errors.js';
import { runScan, type ScanSummary } from '../discovery/scan.js';
import { runScreening, type ScreenSummary } from '../evaluate/screen.js';
import { Evaluator } from '../evaluate/evaluator.js';
import { BudgetGuard } from '../evaluate/budget.js';
import { rankForEvaluation, type RankedJob } from '../evaluate/priority.js';
import { criteriaHash as criteriaHashOf } from '../evaluate/criteria.js';
import { createProvider } from '../reasoning/registry.js';

/**
 * The daily run, as one sequence.
 *
 * `scan`, `screen` and `evaluate` were three commands a user had to remember to
 * type in the right order, and the portal could not start any of them. Chaining
 * them is new behaviour, so it lives here rather than in the web layer: the
 * portal's run button and `roleeye run` call this same function, which is the
 * only way the two can be guaranteed to mean the same thing.
 *
 * Nothing about *what* a stage does is decided here. Each stage delegates to
 * the module that already owned it, so the sequence cannot quietly acquire
 * rules of its own.
 */

export const PIPELINE_STAGES = ['scan', 'screen', 'evaluate'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export function isPipelineStage(value: unknown): value is PipelineStage {
  return typeof value === 'string' && (PIPELINE_STAGES as readonly string[]).includes(value);
}

export type PipelineEvent =
  | { kind: 'stage-start'; stage: PipelineStage; at: string; message: string }
  | {
      kind: 'progress';
      stage: PipelineStage;
      at: string;
      message: string;
      done: number;
      total: number | undefined;
    }
  | { kind: 'stage-done'; stage: PipelineStage; at: string; message: string }
  | { kind: 'stage-failed'; stage: PipelineStage; at: string; message: string }
  | { kind: 'stage-skipped'; stage: PipelineStage; at: string; message: string };

export interface PipelineOptions {
  config: AppConfig;
  db: Database;
  repos: Repositories;
  logger: Logger;
  /** Which stages to run, in the fixed order scan -> screen -> evaluate. */
  stages: readonly PipelineStage[];
  /** Roles to evaluate; defaults to `budget.max_jobs_per_scan`. */
  limit?: number | undefined;
  /** Re-screen and re-evaluate work that is already current. */
  force?: boolean | undefined;
  /** Restrict the scan to specific source names or types. */
  only?: string[] | undefined;
  signal?: AbortSignal | undefined;
  onEvent?: ((event: PipelineEvent) => void) | undefined;
}

export interface PipelineResult {
  startedAt: string;
  finishedAt: string;
  /** `cancelled` means the user stopped it; work already committed still stands. */
  status: 'ok' | 'warning' | 'failed' | 'cancelled';
  scan: ScanSummary | undefined;
  screen: ScreenSummary | undefined;
  evaluate: EvaluateSummary | undefined;
  /** Stages that produced nothing. A failed stage never silently ends the run. */
  errors: Array<{ stage: PipelineStage; message: string }>;
  /**
   * Partial problems: the stage ran and produced something, but not everything.
   *
   * Kept apart from `errors` because they mean different things to the status.
   * One board of twelve timing out is a run worth keeping and worth mentioning;
   * folding it into `errors` made a single-stage run report total failure.
   */
  warnings: Array<{ stage: PipelineStage; message: string }>;
}

export interface EvaluateSummary {
  eligible: number;
  attempted: number;
  evaluated: number;
  /** Served from cache rather than re-asked. */
  reused: number;
  failed: number;
  apply: number;
  maybe: number;
  pass: number;
  scanCostUsd: number;
  monthCostUsd: number;
  budgetExhausted: boolean;
}

/**
 * The roles most likely to repay an expensive call, best first.
 *
 * Lifted out of `cli/evaluate.ts` so the CLI and the portal rank identically.
 * A cap that keeps whatever the database returned first is a cap that throws
 * away the best role.
 */
export function rankEligible(repos: Repositories, config: AppConfig): RankedJob[] {
  const criteriaHash = criteriaHashOf(config.criteria);
  const screeningFor = (jobId: string) => repos.screenings.findCurrent(jobId, criteriaHash);

  const candidates = repos.jobs
    .list({ inScope: true, limit: 500 })
    // A role the screener rejected is not a candidate; an unscreened one still is.
    .filter((job) => screeningFor(job.id)?.eligible !== false);

  return rankForEvaluation(candidates, screeningFor);
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { config, db, repos, logger, signal } = options;
  const startedAt = nowIso();
  const errors: PipelineResult['errors'] = [];
  const warnings: PipelineResult['warnings'] = [];

  const emit = (event: PipelineEvent): void => {
    try {
      options.onEvent?.(event);
    } catch (error) {
      // A listener is a display concern; it must never fail the run.
      logger.debug('pipeline listener threw', { error: errorMessage(error) });
    }
  };

  const wanted = new Set(options.stages);
  let scan: ScanSummary | undefined;
  let screen: ScreenSummary | undefined;
  let evaluate: EvaluateSummary | undefined;
  let cancelled = false;

  const stopped = (): boolean => {
    if (!signal?.aborted) return false;
    cancelled = true;
    return true;
  };

  if (wanted.has('scan') && !stopped()) {
    emit({ kind: 'stage-start', stage: 'scan', at: nowIso(), message: 'Fetching your sources' });
    try {
      scan = await runScan({
        config,
        db,
        repos,
        logger,
        ...(options.only ? { only: options.only } : {}),
        ...(signal ? { signal } : {}),
        onProgress: (update) => {
          if (update.phase === 'source-start') {
            emit({
              kind: 'progress',
              stage: 'scan',
              at: nowIso(),
              message: `Reading ${update.sourceName}`,
              done: update.index - 1,
              total: update.total,
            });
            return;
          }

          const summary = update.summary;
          const detail =
            summary === undefined
              ? ''
              : summary.status === 'failed'
                ? ` — failed: ${summary.error ?? 'unknown error'}`
                : ` — ${summary.fetched} seen, ${summary.new} new, ${summary.changed} changed`;

          emit({
            kind: 'progress',
            stage: 'scan',
            at: nowIso(),
            message: `${update.sourceName}${detail}`,
            done: update.index,
            total: update.total,
          });
        },
      });

      const broken = scan.sources.filter((source) => source.status === 'failed');

      if (scan.status === 'failed') {
        errors.push({ stage: 'scan', message: 'every source failed' });
      } else if (broken.length > 0) {
        // A run that read eleven boards and could not read the twelfth is not
        // "ok". Reporting it as such is how a source stays broken for weeks.
        warnings.push({
          stage: 'scan',
          message: `${broken.map((source) => source.sourceName).join(', ')} could not be read: ${
            broken[0]?.error ?? 'unknown error'
          }`,
        });
      }

      emit({
        kind: scan.status === 'failed' ? 'stage-failed' : 'stage-done',
        stage: 'scan',
        at: nowIso(),
        message:
          `${scan.totals.new} new, ${scan.totals.changed} changed, ${scan.totals.reposted} reposted, ${scan.totals.outOfScope} out of scope` +
          (broken.length > 0 && scan.status !== 'failed'
            ? ` — but ${broken.length} source(s) failed: ${broken.map((source) => source.sourceName).join(', ')}`
            : ''),
      });
    } catch (error) {
      const message = errorMessage(error);
      errors.push({ stage: 'scan', message });
      emit({ kind: 'stage-failed', stage: 'scan', at: nowIso(), message });
    }
  }

  if (wanted.has('screen') && !stopped()) {
    emit({ kind: 'stage-start', stage: 'screen', at: nowIso(), message: 'Applying your rules' });
    try {
      screen = runScreening(repos, {
        criteria: config.criteria,
        ...(options.force === undefined ? {} : { force: options.force }),
      });

      emit({
        kind: 'stage-done',
        stage: 'screen',
        at: nowIso(),
        message: `${screen.eligible} eligible, ${screen.rejected} rejected by your rules${
          screen.blocked > 0 ? `, ${screen.blocked} blocked for fraud risk` : ''
        }`,
      });
    } catch (error) {
      const message = errorMessage(error);
      errors.push({ stage: 'screen', message });
      emit({ kind: 'stage-failed', stage: 'screen', at: nowIso(), message });
    }
  }

  if (wanted.has('evaluate') && !stopped()) {
    try {
      evaluate = await runEvaluateStage(options, emit, () => cancelled, (value) => { cancelled = value; });

      if (evaluate.failed > 0) {
        warnings.push({
          stage: 'evaluate',
          message: `${evaluate.failed} role(s) could not be assessed. The rest were.`,
        });
      }
    } catch (error) {
      const message = errorMessage(error);
      errors.push({ stage: 'evaluate', message });
      emit({ kind: 'stage-failed', stage: 'evaluate', at: nowIso(), message });
    }
  }

  // Checked once more at the end. Aborting during the last source or the last
  // assessment leaves no later checkpoint to notice it, so a run the user
  // stopped would otherwise report that it finished cleanly.
  if (signal?.aborted) cancelled = true;

  // Every stage failing is a failed run. Some of them failing, or a stage
  // half-succeeding, is a run whose output is still worth having — but never
  // one that should be reported as clean.
  const status: PipelineResult['status'] = cancelled
    ? 'cancelled'
    : errors.length > 0 && errors.length === options.stages.length
      ? 'failed'
      : errors.length > 0 || warnings.length > 0
        ? 'warning'
        : 'ok';

  return { startedAt, finishedAt: nowIso(), status, scan, screen, evaluate, errors, warnings };
}

/**
 * The only stage that costs money, so it is the only one with a cap.
 *
 * The provider is created here rather than by the caller because a portal that
 * built one at startup would hold a model connection open for a page nobody is
 * using, and would not notice the user changing providers in the next panel.
 */
async function runEvaluateStage(
  options: PipelineOptions,
  emit: (event: PipelineEvent) => void,
  isCancelled: () => boolean,
  setCancelled: (value: boolean) => void,
): Promise<EvaluateSummary> {
  const { config, repos, logger, signal } = options;

  if (config.criteria.reasoning.provider === 'none') {
    emit({
      kind: 'stage-skipped',
      stage: 'evaluate',
      at: nowIso(),
      message: 'No reasoning engine is configured, so nothing was assessed. Pick one under Engine.',
    });

    return {
      eligible: 0,
      attempted: 0,
      evaluated: 0,
      reused: 0,
      failed: 0,
      apply: 0,
      maybe: 0,
      pass: 0,
      scanCostUsd: 0,
      monthCostUsd: BudgetGuard.monthToDateCost(repos.llmCalls),
      budgetExhausted: false,
    };
  }

  const limit = options.limit ?? config.criteria.budget.max_jobs_per_scan;
  const candidates = rankEligible(repos, config);
  const jobs: JobRecord[] = candidates.slice(0, Math.max(limit, 0)).map((entry) => entry.job);

  emit({
    kind: 'stage-start',
    stage: 'evaluate',
    at: nowIso(),
    message:
      jobs.length === 0
        ? 'Nothing eligible to assess'
        : `Assessing the ${jobs.length} highest-priority role(s) of ${candidates.length} eligible`,
  });

  const monthCost = BudgetGuard.monthToDateCost(repos.llmCalls);
  const budget = new BudgetGuard(config.criteria.budget, monthCost);
  const provider = createProvider({ config: config.criteria.reasoning, logger });
  const evaluator = new Evaluator({ config, repos, provider, logger, budget });

  const summary: EvaluateSummary = {
    eligible: candidates.length,
    attempted: 0,
    evaluated: 0,
    reused: 0,
    failed: 0,
    apply: 0,
    maybe: 0,
    pass: 0,
    scanCostUsd: 0,
    monthCostUsd: monthCost,
    budgetExhausted: false,
  };

  for (const [index, job] of jobs.entries()) {
    if (signal?.aborted) {
      setCancelled(true);
      emit({
        kind: 'progress',
        stage: 'evaluate',
        at: nowIso(),
        message: `Stopped after ${index} of ${jobs.length}. Everything already assessed is saved.`,
        done: index,
        total: jobs.length,
      });
      break;
    }

    emit({
      kind: 'progress',
      stage: 'evaluate',
      at: nowIso(),
      message: `Assessing ${job.companyName} — ${job.title}`,
      done: index,
      total: jobs.length,
    });

    summary.attempted += 1;

    let outcome: string;
    let detail: string;

    try {
      const result = await evaluator.evaluate(job, options.force === undefined ? {} : { force: options.force });
      outcome = result.outcome;
      detail = result.detail ?? '';

      if (result.evaluation) {
        summary.evaluated += 1;
        if (result.outcome === 'cached') summary.reused += 1;
        if (result.evaluation.decision === 'APPLY') summary.apply += 1;
        else if (result.evaluation.decision === 'MAYBE') summary.maybe += 1;
        else summary.pass += 1;

        detail = `${result.evaluation.decision} ${result.evaluation.score}`;
      } else {
        summary.failed += 1;
      }

      if (result.outcome === 'budget-exhausted') {
        summary.budgetExhausted = true;
        if (budget.stopsOnExhaustion) {
          emit({
            kind: 'progress',
            stage: 'evaluate',
            at: nowIso(),
            message: `Stopped: ${result.detail ?? 'budget reached'}`,
            done: index + 1,
            total: jobs.length,
          });
          break;
        }
      }
    } catch (error) {
      summary.failed += 1;
      outcome = 'failed';
      detail = errorMessage(error);
      logger.warn('evaluation failed', { jobId: job.id, error: detail });
    }

    emit({
      kind: 'progress',
      stage: 'evaluate',
      at: nowIso(),
      message: `${job.companyName} — ${job.title}: ${detail.length > 0 ? detail : outcome}`,
      done: index + 1,
      total: jobs.length,
    });
  }

  const state = budget.state();
  summary.scanCostUsd = state.scanCostUsd;
  summary.monthCostUsd = state.monthCostUsd;

  if (!isCancelled()) {
    emit({
      kind: 'stage-done',
      stage: 'evaluate',
      at: nowIso(),
      message:
        summary.attempted === 0
          ? 'Nothing eligible to assess. Widen your sources or loosen your rules.'
          : `${summary.apply} apply, ${summary.maybe} maybe, ${summary.pass} pass` +
            (summary.failed > 0 ? `, ${summary.failed} failed` : '') +
            ` — $${state.scanCostUsd.toFixed(4)} this run`,
    });
  }

  return summary;
}
