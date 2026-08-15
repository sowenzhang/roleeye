import { ExitCode, UsageError } from '../util/errors.js';
import type { AppConfig } from '../config/load.js';
import type { Repositories } from '../db/repositories/index.js';
import {
  funnel,
  segments,
  SEGMENT_DIMENSIONS,
  type FunnelResult,
  type SegmentDimension,
  type SegmentRow,
} from '../analytics/funnel.js';
import { truncate } from '../normalize/text.js';
import { flagBool, flagNumber, flagString } from './args.js';
import { printJson, printLine, type Command, type CommandContext } from './command.js';

/**
 * The daily read: what is worth your attention, and why.
 *
 * Deliberately short. A long essay per role is how a recommendation list stops
 * being read (agent.md notification format).
 */
export const recommendCommand: Command = {
  name: 'recommend',
  summary: 'Show the roles worth your attention, best first',
  usage: 'roleeye recommend [--limit <n>] [--decision APPLY|MAYBE] [--json]',

  run(context: CommandContext) {
    const { repos } = context.openDb();

    const decision = flagString(context.args, 'decision')?.toUpperCase();
    const decisions = decision === 'APPLY' ? (['APPLY'] as const) : (['APPLY', 'MAYBE'] as const);

    const evaluations = repos.evaluations.listRecommendations(flagNumber(context.args, 'limit') ?? 10, [...decisions]);

    if (context.json) {
      printJson(
        context,
        evaluations.map((evaluation) => {
          const job = repos.jobs.findById(evaluation.jobId);
          return {
            jobId: evaluation.jobId,
            company: job?.companyName,
            title: job?.title,
            decision: evaluation.decision,
            score: evaluation.score,
            confidence: evaluation.confidence,
            headline: evaluation.headline,
          };
        }),
      );
      return ExitCode.Ok;
    }

    if (evaluations.length === 0) {
      printLine(context, 'Nothing evaluated yet.');
      printLine(context);
      printLine(context, '  roleeye scan       find roles');
      printLine(context, '  roleeye screen     apply your rules');
      printLine(context, '  roleeye evaluate   assess the survivors');
      return ExitCode.Ok;
    }

    for (const evaluation of evaluations) {
      const job = repos.jobs.findById(evaluation.jobId);
      if (!job) continue;

      const payload = evaluation.advocate as { assessment?: { concerns?: string[]; questions_to_verify?: string[] } } | undefined;
      const assessment = payload?.assessment;

      printLine(context);
      printLine(context, `${job.companyName} — ${job.title}`);
      printLine(context, `Score: ${evaluation.score} — ${evaluation.decision}    ${job.id}`);

      if (evaluation.headline) printLine(context, `  ${evaluation.headline}`);

      const concern = assessment?.concerns?.[0];
      if (concern) printLine(context, `  Concern: ${truncate(concern, 100)}`);

      const question = assessment?.questions_to_verify?.[0];
      if (question) printLine(context, `  Verify:  ${truncate(question, 100)}`);
    }

    printLine(context);
    printLine(context, `See the full reasoning with \`roleeye evaluate <job-id>\`.`);

    return ExitCode.Ok;
  },
};

/** Spend reporting and the funnel: what this has cost, and what it has produced. */
export const statsCommand: Command = {
  name: 'stats',
  summary: 'Report the funnel, segments, and model spend',
  usage: 'roleeye stats [--funnel] [--segment <dimension>] [--cost] [--since <iso-date>] [--until <iso-date>] [--json]',

  run(context: CommandContext) {
    const { db, repos } = context.openDb();
    const config = context.loadConfig({ allowDefaults: true });

    const since = isoOrUndefined(flagString(context.args, 'since'));
    const until = isoOrUndefined(flagString(context.args, 'until'));
    const dimension = flagString(context.args, 'segment');

    if (dimension && !SEGMENT_DIMENSIONS.includes(dimension as SegmentDimension)) {
      throw new UsageError(`unknown segment "${dimension}". One of: ${SEGMENT_DIMENSIONS.join(', ')}`);
    }

    // Cost is opt-in and so is the funnel; asking for neither shows the funnel,
    // because "what has this produced" is the question and "what did it cost"
    // is the follow-up.
    const wantsCost = flagBool(context.args, 'cost');
    const wantsFunnel = flagBool(context.args, 'funnel') || dimension !== undefined || !wantsCost;

    const window = { since, until };
    const report = wantsFunnel ? funnel(db, window) : undefined;
    const rows = dimension ? segments(db, dimension as SegmentDimension, window) : undefined;
    const spend = wantsCost ? spendReport(repos, config, since) : undefined;

    if (context.json) {
      printJson(context, { funnel: report, segment: dimension, segments: rows, spend });
      return ExitCode.Ok;
    }

    if (report) printFunnel(context, report);
    if (rows) printSegments(context, dimension as SegmentDimension, rows);
    if (spend) printSpend(context, spend);

    return ExitCode.Ok;
  },
};

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new UsageError(`not a date: "${value}"`);
  return parsed.toISOString();
}

const STAGE_LABELS: Record<string, string> = {
  discovered: 'discovered',
  in_scope: 'in scope',
  screened: 'screened',
  eligible: 'eligible',
  evaluated: 'evaluated',
  recommended: 'recommended',
  applied: 'applied',
  recruiter_screen: 'recruiter screen',
  interviewing: 'interviewing',
  final: 'final round',
  offer: 'offer',
};

function printFunnel(context: CommandContext, report: FunnelResult): void {
  printLine(context, report.since || report.until ? `Funnel (${report.since?.slice(0, 10) ?? 'start'} → ${report.until?.slice(0, 10) ?? 'now'})` : 'Funnel');
  printLine(context);

  const widest = Math.max(...Object.values(report.counts));

  for (const [stage, value] of Object.entries(report.counts)) {
    const bar = widest > 0 ? '█'.repeat(Math.round((value / widest) * 24)) : '';
    printLine(context, `  ${(STAGE_LABELS[stage] ?? stage).padEnd(17)} ${String(value).padStart(6)}  ${bar}`);
  }

  printLine(context);
  const rates = [
    describeRate('recommended of evaluated', report.rates.recommendationRate),
    describeRate('applied of recommended', report.rates.applyRate),
    describeRate('recruiter screens per application', report.rates.screenRate),
    describeRate('interviews per application', report.rates.interviewRate),
    describeRate('offers per application', report.rates.offerRate),
  ].filter((line): line is string => line !== undefined);

  for (const line of rates) printLine(context, `  ${line}`);

  if (rates.length === 0) {
    printLine(context, '  No rates yet: nothing has been evaluated or applied to.');
  }

  if (report.overrides.length > 0) {
    printLine(context);
    printLine(context, `  Overrides: ${report.overrides.map((entry) => `${entry.kind.replace(/_/g, ' ')} ${entry.count}`).join(', ')}`);
  }

  printLine(context);
}

/** A rate with no denominator is omitted, never printed as 0%. */
function describeRate(label: string, value: number | undefined): string | undefined {
  return value === undefined ? undefined : `${label}: ${(value * 100).toFixed(0)}%`;
}

function printSegments(context: CommandContext, dimension: SegmentDimension, rows: SegmentRow[]): void {
  printLine(context, `Applications by ${dimension.replace(/_/g, ' ')}`);
  printLine(context);

  if (rows.length === 0) {
    printLine(context, '  Nothing applied to yet. Segments describe outcomes, not postings.');
    printLine(context);
    return;
  }

  printLine(context, `  ${'segment'.padEnd(24)} ${'apps'.padStart(5)} ${'screens'.padStart(8)} ${'ivs'.padStart(5)} ${'offers'.padStart(7)} ${'screen %'.padStart(9)}`);
  for (const row of rows) {
    printLine(
      context,
      `  ${truncate(row.segment, 24).padEnd(24)} ${String(row.applications).padStart(5)} ${String(row.screens).padStart(8)} ` +
        `${String(row.interviews).padStart(5)} ${String(row.offers).padStart(7)} ` +
        `${(row.screenRate === undefined ? '—' : `${(row.screenRate * 100).toFixed(0)}%`).padStart(9)}`,
    );
  }

  printLine(context);
}

interface SpendReport {
  total: number;
  monthToDate: number;
  budget: number;
  byStage: ReturnType<Repositories['llmCalls']['summarize']>;
}

function spendReport(repos: Repositories, config: AppConfig, since: string | undefined): SpendReport {
  const summaries = repos.llmCalls.summarize(since);

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  return {
    total: summaries.reduce((sum, entry) => sum + entry.estimatedCostUsd, 0),
    monthToDate: repos.llmCalls.totalCost(monthStart.toISOString()),
    budget: config.criteria.budget.max_cost_per_month_usd,
    byStage: summaries,
  };
}

function printSpend(context: CommandContext, spend: SpendReport): void {
  printLine(context, 'Model spend');
  printLine(context);

  if (spend.byStage.length === 0) {
    printLine(context, '  Nothing spent yet. Screening and discovery cost nothing by design.');
    return;
  }

  printLine(context, `  ${'stage'.padEnd(12)} ${'model'.padEnd(22)} ${'calls'.padStart(6)} ${'in'.padStart(9)} ${'out'.padStart(8)} ${'cost'.padStart(9)}`);
  for (const entry of spend.byStage) {
    printLine(
      context,
      `  ${entry.stage.padEnd(12)} ${truncate(entry.model, 22).padEnd(22)} ${String(entry.calls).padStart(6)} ` +
        `${entry.inputTokens.toLocaleString('en-US').padStart(9)} ${entry.outputTokens.toLocaleString('en-US').padStart(8)} ` +
        `${('$' + entry.estimatedCostUsd.toFixed(4)).padStart(9)}`,
    );
  }

  printLine(context);
  printLine(context, `  Total: $${spend.total.toFixed(4)}`);
  printLine(context, `  This month: $${spend.monthToDate.toFixed(2)} of $${spend.budget.toFixed(2)} budget`);
}
