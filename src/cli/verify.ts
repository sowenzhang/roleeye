import { ExitCode, NotFoundError, UsageError } from '../util/errors.js';
import type { Repositories } from '../db/repositories/index.js';
import type { JobRecord } from '../db/repositories/jobs.js';
import { createCriteriaContext } from '../evaluate/criteria.js';
import { screenJob } from '../evaluate/screen.js';
import { nowIso } from '../util/time.js';
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

const SEVERITY_MARK: Record<string, string> = { info: 'i', concern: '!', alarm: 'x' };

/**
 * Explains one role signal by signal.
 *
 * A verdict the user cannot interrogate is a verdict they will stop trusting,
 * so everything that fired is shown along with the rule that produced it.
 */
export const verifyCommand: Command = {
  name: 'verify',
  summary: 'Explain the screening decision for one role',
  usage: 'roleeye verify <job-id> [--json]',

  run(context: CommandContext) {
    const reference = context.args.positionals[0];
    if (!reference) throw new UsageError('missing job id. Usage: roleeye verify <job-id>');

    const config = context.loadConfig();
    const { repos } = context.openDb();
    const job = resolveJob(repos, reference);

    const criteria = createCriteriaContext(config.criteria);
    const screening = screenJob(repos, job, config.criteria, criteria.hash, nowIso());

    if (context.json) {
      printJson(context, { job: { id: job.id, company: job.companyName, title: job.title }, screening });
      return ExitCode.Ok;
    }

    printLine(context, `${job.companyName} — ${job.title}`);
    printLine(context, `${job.id}`);
    printLine(context);

    printLine(context, `  Eligible:     ${screening.eligible ? 'yes' : 'no'}`);
    printLine(context, `  Freshness:    ${screening.authenticity.freshness}`);
    printLine(context, `  Hiring:       ${screening.authenticity.hiringIntent}`);
    printLine(context, `  Fraud risk:   ${screening.authenticity.fraudRisk}`);
    printLine(context, `  Provenance:   ${screening.authenticity.provenance}`);

    if (screening.rejections.length > 0) {
      printLine(context);
      printLine(context, '  Rejected by your rules:');
      for (const rejection of screening.rejections) {
        printLine(context, `    ${rejection.rule}: ${rejection.detail}`);
      }
    }

    if (screening.warnings.length > 0) {
      printLine(context);
      printLine(context, '  Could not be checked:');
      for (const warning of screening.warnings) {
        printLine(context, `    ${warning.rule}: ${warning.detail}`);
      }
    }

    if (screening.authenticity.signals.length > 0) {
      printLine(context);
      printLine(context, '  Authenticity signals:');
      for (const signal of screening.authenticity.signals) {
        printLine(context, `    [${SEVERITY_MARK[signal.severity] ?? '?'}] ${signal.code}: ${signal.detail}`);
      }
    }

    if (screening.authenticity.blocked) {
      printLine(context);
      printLine(context, '  BLOCKED: this posting shows strong scam markers. No artifacts will be generated.');
      printLine(context, '  Nothing here is sent anywhere, and the poster is never contacted.');
    }

    printLine(context);
    printLine(context, '  Screening is deterministic: no model was called, and nothing was spent.');

    return ExitCode.Ok;
  },
};
