import { ExitCode } from '../util/errors.js';
import { truncate } from '../normalize/text.js';
import { flagNumber, flagString } from './args.js';
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

/** Spend reporting. Phase 6 adds the funnel; this is the part that costs money. */
export const statsCommand: Command = {
  name: 'stats',
  summary: 'Report model spend',
  usage: 'roleeye stats --cost [--since <iso-date>] [--json]',

  run(context: CommandContext) {
    const { repos } = context.openDb();
    const config = context.loadConfig({ allowDefaults: true });

    const since = flagString(context.args, 'since');
    const summaries = repos.llmCalls.summarize(since ? new Date(since).toISOString() : undefined);
    const total = summaries.reduce((sum, entry) => sum + entry.estimatedCostUsd, 0);

    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const monthCost = repos.llmCalls.totalCost(monthStart.toISOString());

    if (context.json) {
      printJson(context, { total, monthToDate: monthCost, budget: config.criteria.budget, byStage: summaries });
      return ExitCode.Ok;
    }

    printLine(context, 'Model spend');
    printLine(context);

    if (summaries.length === 0) {
      printLine(context, '  Nothing spent yet. Screening and discovery cost nothing by design.');
      return ExitCode.Ok;
    }

    printLine(context, `  ${'stage'.padEnd(12)} ${'model'.padEnd(22)} ${'calls'.padStart(6)} ${'in'.padStart(9)} ${'out'.padStart(8)} ${'cost'.padStart(9)}`);
    for (const entry of summaries) {
      printLine(
        context,
        `  ${entry.stage.padEnd(12)} ${truncate(entry.model, 22).padEnd(22)} ${String(entry.calls).padStart(6)} ` +
          `${entry.inputTokens.toLocaleString('en-US').padStart(9)} ${entry.outputTokens.toLocaleString('en-US').padStart(8)} ` +
          `${('$' + entry.estimatedCostUsd.toFixed(4)).padStart(9)}`,
      );
    }

    printLine(context);
    printLine(context, `  Total: $${total.toFixed(4)}`);
    printLine(
      context,
      `  This month: $${monthCost.toFixed(2)} of $${config.criteria.budget.max_cost_per_month_usd.toFixed(2)} budget`,
    );

    return ExitCode.Ok;
  },
};
