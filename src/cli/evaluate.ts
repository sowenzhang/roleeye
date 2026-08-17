import { ExitCode, NotFoundError, UsageError, type ExitCodeValue } from '../util/errors.js';
import type { Repositories } from '../db/repositories/index.js';
import type { JobRecord } from '../db/repositories/jobs.js';
import { Evaluator } from '../evaluate/evaluator.js';
import { BudgetGuard } from '../evaluate/budget.js';
import { largeRunWarning } from '../evaluate/priority.js';
import { rankEligible } from '../core/pipeline.js';
import { withRunLock } from './with-lock.js';
import { createProvider, describeProvider, isLocalProvider } from '../reasoning/registry.js';
import { truncate } from '../normalize/text.js';
import { flagBool, flagNumber, flagString } from './args.js';
import { printJson, printLine, type Command, type CommandContext } from './command.js';

function resolveJob(repos: Repositories, reference: string): JobRecord {
  const exact = repos.jobs.findById(reference);
  if (exact) return exact;

  const withPrefix = reference.startsWith('job_') ? reference : `job_${reference}`;
  const matches = repos.jobs.findByIdPrefix(withPrefix);

  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length > 1) {
    throw new UsageError(
      `job id "${reference}" is ambiguous:\n${matches.map((job) => `  ${job.id}  ${job.companyName} — ${job.title}`).join('\n')}`,
    );
  }

  throw new NotFoundError(`no job found for "${reference}"`);
}

/**
 * Evaluates one role, or everything eligible.
 *
 * `--dry-run` prints the exact prompts and the estimated cost without calling
 * anything, because nobody should have to spend money to find out what a tool
 * would send on their behalf.
 */
export const evaluateCommand: Command = {
  name: 'evaluate',
  summary: 'Assess role fit with the configured model',
  usage: 'roleeye evaluate [<job-id>] [--all] [--limit <n>] [--force] [--dry-run] [--json]',

  async run(context: CommandContext) {
    const config = context.loadConfig();
    const { db, repos } = context.openDb();

    const reference = context.args.positionals[0];
    const all = flagBool(context.args, 'all') || reference === undefined;
    const dryRun = flagBool(context.args, 'dry-run');

    const monthCost = BudgetGuard.monthToDateCost(repos.llmCalls);
    const budget = new BudgetGuard(config.criteria.budget, monthCost);

    const provider = dryRun ? undefined : createProvider({ config: config.criteria.reasoning, logger: context.logger });

    const evaluator = new Evaluator({ config, repos, provider, logger: context.logger, budget });

    if (dryRun) {
      const job = reference ? resolveJob(repos, reference) : repos.jobs.list({ inScope: true, limit: 1 })[0];
      if (!job) {
        printLine(context, 'Nothing stored to preview. Run `roleeye scan` first.');
        return ExitCode.Ok;
      }
      // Nothing is sent and nothing is written, so there is nothing to serialise.
      return describeDryRun(context, evaluator, job, config);
    }

    // The only command that spends money, and the only one where overlapping
    // another run means paying twice: each process builds its own budget guard,
    // so a per-run cap would apply once to each.
    return withRunLock(context, db, 'evaluate', async () => {
    const limit = flagNumber(context.args, 'limit') ?? config.criteria.budget.max_jobs_per_scan;
    const candidates = reference ? [] : rankEligible(repos, config);
    const jobs = reference ? [resolveJob(repos, reference)] : candidates.slice(0, limit).map((entry) => entry.job);

    if (jobs.length === 0) {
      printLine(context, 'Nothing eligible to evaluate. Run `roleeye screen` first.');
      return ExitCode.Ok;
    }

    if (!reference) {
      const minutes = minutesPerRole(config.criteria.reasoning);
      const warning = minutes === undefined ? undefined : largeRunWarning(limit, minutes);
      if (warning) {
        printLine(context, warning);
        printLine(context, 'Lower it with --limit, or set budget.max_jobs_per_scan.');
        printLine(context);
      }

      printLine(context, `Evaluating the ${jobs.length} highest-priority role(s) of ${candidates.length} eligible.`);
      printLine(context);
    }

    const force = flagBool(context.args, 'force');
    const results = [];

    for (const job of jobs) {
      const result = await evaluator.evaluate(job, { force });
      results.push({ job, result });

      if (result.outcome === 'budget-exhausted' && budget.stopsOnExhaustion) {
        context.logger.warn('stopping: budget reached', { detail: result.detail });
        break;
      }

      if (!context.json && all) {
        printLine(context, `  ${describeOutcome(job, result)}`);
      }
    }

    if (context.json) {
      printJson(context, {
        budget: budget.state(),
        results: results.map(({ job, result }) => ({
          jobId: job.id,
          company: job.companyName,
          title: job.title,
          outcome: result.outcome,
          decision: result.evaluation?.decision,
          score: result.evaluation?.score,
          detail: result.detail,
        })),
      });
      return ExitCode.Ok;
    }

    if (!all && results[0]) {
      printEvaluation(context, results[0].job, results[0].result);
    }

    const state = budget.state();
    printLine(context);
    printLine(
      context,
      `Spent $${state.scanCostUsd.toFixed(4)} this run, $${state.monthCostUsd.toFixed(2)} this month.`,
    );

    return ExitCode.Ok;
    });
  },
};

/**
 * Measured: an agent CLI takes minutes per role, an API a few seconds.
 *
 * Undefined when nothing is configured, because an estimate of how long it
 * would take to do nothing is not information.
 */
function minutesPerRole(reasoning: { provider: string; passes: number }): number | undefined {
  if (reasoning.provider === 'none') return undefined;
  return (reasoning.provider === 'agent-cli' ? 3.5 : 0.1) * reasoning.passes;
}

function describeOutcome(job: JobRecord, result: { outcome: string; evaluation?: { decision: string; score: number } | undefined; detail?: string | undefined }): string {
  const label = `${truncate(job.companyName, 18).padEnd(18)} ${truncate(job.title, 40).padEnd(40)}`;

  if (result.evaluation) {
    return `${label} ${result.evaluation.decision.padEnd(6)} ${result.evaluation.score}`;
  }
  return `${label} ${result.outcome}${result.detail ? ` — ${truncate(result.detail, 60)}` : ''}`;
}

function printEvaluation(
  context: CommandContext,
  job: JobRecord,
  result: Awaited<ReturnType<Evaluator['evaluate']>>,
): void {
  printLine(context, `${job.companyName} — ${job.title}`);
  printLine(context, job.id);
  printLine(context);

  if (!result.evaluation) {
    printLine(context, `  ${result.outcome}: ${result.detail ?? 'no evaluation produced'}`);
    return;
  }

  const evaluation = result.evaluation;
  const payload = evaluation.advocate as { assessment?: Record<string, unknown> } | undefined;
  const assessment = payload?.assessment as
    | { concerns?: string[]; strengths?: string[]; questions_to_verify?: string[] }
    | undefined;
  const scoring = evaluation.judge as { breakdown?: Array<Record<string, unknown>>; penalties?: Array<Record<string, unknown>> } | undefined;

  printLine(context, `  ${evaluation.decision}  ${evaluation.score}/100   confidence ${evaluation.confidence ?? '?'}`);
  printLine(context, `  ${evaluation.headline ?? ''}`);

  if (scoring?.breakdown) {
    printLine(context);
    printLine(context, '  Score:');
    for (const entry of scoring.breakdown) {
      const category = String(entry['category']).padEnd(18);
      const final = String(entry['finalScore']).padStart(3);
      const weight = String(entry['weight']).padStart(3);
      printLine(context, `    ${category} ${final}  x${weight}%  ${truncate(String(entry['evidence'] ?? ''), 60)}`);
    }
  }

  for (const [heading, items] of [
    ['Why it could work', assessment?.strengths],
    ['Concerns', assessment?.concerns],
    ['Verify before applying', assessment?.questions_to_verify],
  ] as const) {
    if (!items || items.length === 0) continue;
    printLine(context);
    printLine(context, `  ${heading}:`);
    for (const item of items) printLine(context, `    - ${item}`);
  }
}

/** The dry run: exactly what would be sent, and what it would cost. */
function describeDryRun(
  context: CommandContext,
  evaluator: Evaluator,
  job: JobRecord,
  config: ReturnType<CommandContext['loadConfig']>,
): ExitCodeValue {
  const requests = evaluator.describeRequest(job);
  const savings = Evaluator.boilerplateSavings(job);
  const reasoning = config.criteria.reasoning;
  const pricing = reasoning.pricing;

  const passes = reasoning.passes;
  const inputTokens = requests.reduce((sum, request) => sum + request.estimatedTokens, 0);
  const outputTokens = reasoning.max_output_tokens * requests.length;
  const perJob =
    (inputTokens / 1_000_000) * pricing.input_per_mtok + (outputTokens / 1_000_000) * pricing.output_per_mtok;

  if (context.json) {
    printJson(context, {
      job: { id: job.id, company: job.companyName, title: job.title },
      provider: describeProvider(reasoning),
      local: isLocalProvider(reasoning),
      passes,
      estimatedInputTokens: inputTokens,
      estimatedOutputTokens: outputTokens,
      estimatedCostUsd: Number(perJob.toFixed(6)),
      requests,
    });
    return ExitCode.Ok;
  }

  printLine(context, `Dry run — ${job.companyName} — ${job.title}`);
  printLine(context);
  printLine(context, `  Provider:     ${describeProvider(reasoning)}`);
  printLine(
    context,
    `  Data leaves this machine: ${
      reasoning.provider === 'none' ? 'nothing configured, so nothing would be sent' : isLocalProvider(reasoning) ? 'no' : 'yes'
    }`,
  );
  printLine(context, `  Passes:       ${passes}`);
  printLine(context, `  Profile:      ${evaluator.profileInfo.exists ? `${evaluator.profileInfo.redactions} detail(s) redacted before sending` : 'none found'}`);
  printLine(context, `  Description:  ${savings.before} tokens, ${savings.after} after stripping boilerplate`);
  printLine(context, `  Estimated:    ~${inputTokens} in, ~${outputTokens} out, $${perJob.toFixed(4)} for this role`);
  printLine(context);
  printLine(context, '  Nothing was sent. Below is exactly what would be.');

  for (const request of requests) {
    printLine(context);
    printLine(context, `  ${'-'.repeat(66)}`);
    printLine(context, `  STAGE: ${request.stage}`);
    printLine(context, `  ${'-'.repeat(66)}`);
    for (const line of request.system.split('\n')) printLine(context, `  | ${line}`);
    printLine(context, '  |');
    const promptLines = request.prompt.split('\n');
    const shown = flagString(context.args, 'full') === undefined ? promptLines.slice(0, 40) : promptLines;
    for (const line of shown) printLine(context, `  | ${truncate(line, 100)}`);
    if (shown.length < promptLines.length) {
      printLine(context, `  | ... ${promptLines.length - shown.length} more lines (--full to see everything)`);
    }
  }

  return ExitCode.Ok;
}
