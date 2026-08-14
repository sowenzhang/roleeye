import type { ApplicationStatus } from '../core/types.js';
import { ExitCode, NotFoundError, UsageError, type ExitCodeValue } from '../util/errors.js';
import type { Repositories } from '../db/repositories/index.js';
import type { JobRecord } from '../db/repositories/jobs.js';
import { addNote, pipelineSummary, recordApplication, skipRole } from '../applications/track.js';
import { isSensitiveQuestion } from '../db/repositories/answers.js';
import { truncate } from '../normalize/text.js';
import { flagBool, flagList, flagString } from './args.js';
import { printJson, printLine, type Command, type CommandContext } from './command.js';

/**
 * Application tracking.
 *
 * One command with subcommands rather than `apply-record`, `status` and `note`
 * as three more top-level entries. Seventeen commands is already more than
 * anyone reads, and `status` on its own would have collided with
 * `roleeye resume status` in everybody's memory.
 */

const STATUSES: readonly ApplicationStatus[] = [
  'APPLIED',
  'RECRUITER_SCREEN',
  'INTERVIEWING',
  'FINAL',
  'OFFER',
  'REJECTED',
  'WITHDRAWN',
  'CLOSED',
];

const SUBCOMMANDS = ['record', 'status', 'note', 'skip', 'list', 'show', 'answers', 'answer'] as const;

function resolveJob(repos: Repositories, reference: string): JobRecord {
  const exact = repos.jobs.findById(reference);
  if (exact) return exact;

  const matches = repos.jobs.findByIdPrefix(reference.startsWith('job_') ? reference : `job_${reference}`);
  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length > 1) throw new UsageError(`job id "${reference}" is ambiguous`);

  throw new NotFoundError(`no job found for "${reference}"`);
}

export const applyCommand: Command = {
  name: 'apply',
  summary: 'Track applications, their history, and reusable answers',
  usage: `roleeye apply <${SUBCOMMANDS.join('|')}> [options]`,

  run(context: CommandContext): ExitCodeValue {
    const subcommand = context.args.positionals[0];

    if (!subcommand || !SUBCOMMANDS.includes(subcommand as (typeof SUBCOMMANDS)[number])) {
      throw new UsageError(`unknown subcommand "${subcommand ?? '(none)'}". Usage: ${applyCommand.usage}`);
    }

    switch (subcommand) {
      case 'record':
        return record(context);
      case 'status':
        return setStatus(context);
      case 'note':
        return note(context);
      case 'skip':
        return skip(context);
      case 'show':
        return show(context);
      case 'answers':
        return listAnswers(context);
      case 'answer':
        return setAnswer(context);
      default:
        return list(context);
    }
  },
};

function record(context: CommandContext): ExitCodeValue {
  const reference = context.args.positionals[1];
  if (!reference) throw new UsageError('usage: roleeye apply record <job-id> [--url <url>] [--referral <name>] [--note <text>]');

  const { repos } = context.openDb();
  const job = resolveJob(repos, reference);

  const result = recordApplication(repos, job, {
    url: flagString(context.args, 'url'),
    referral: flagString(context.args, 'referral'),
    source: flagString(context.args, 'source'),
    note: flagString(context.args, 'note'),
    reason: flagString(context.args, 'reason'),
  });

  if (context.json) {
    printJson(context, result);
    return ExitCode.Ok;
  }

  printLine(context, `Recorded: ${job.companyName} — ${job.title}`);
  printLine(context);
  printLine(context, `  status:   ${result.application.currentStatus}`);
  if (result.application.archetypeId) {
    printLine(context, `  resume:   ${result.application.archetypeId}${result.application.resumeArtifactId ? ' (with per-application delta)' : ''}`);
  }
  if (result.advice.decision) {
    printLine(context, `  advised:  ${result.advice.decision}${result.advice.score !== undefined ? ` (${Math.round(result.advice.score)})` : ''}`);
  }

  if (result.overrode) {
    printLine(context);
    printLine(context, '  You applied against the recommendation. That is recorded, not corrected —');
    printLine(context, '  it is the most useful thing this tool can learn from you.');
  }

  printLine(context);
  printLine(context, `  Next: roleeye apply status ${job.id} interviewing --note "..."`);

  return ExitCode.Ok;
}

function setStatus(context: CommandContext): ExitCodeValue {
  const [, reference, rawStatus] = context.args.positionals;
  if (!reference || !rawStatus) {
    throw new UsageError(`usage: roleeye apply status <job-id> <${STATUSES.join('|').toLowerCase()}> [--note <text>]`);
  }

  const status = rawStatus.toUpperCase().replace(/-/g, '_') as ApplicationStatus;
  if (!STATUSES.includes(status)) {
    throw new UsageError(`unknown status "${rawStatus}". One of: ${STATUSES.join(', ').toLowerCase()}`);
  }

  const { repos } = context.openDb();
  const job = resolveJob(repos, reference);
  const application = repos.applications.findByJob(job.id);

  if (!application) {
    throw new UsageError(`no application recorded for ${job.id}. Run \`roleeye apply record ${job.id}\` first.`);
  }

  const note = flagString(context.args, 'note');
  const updated = repos.applications.setStatus(application.id, status, note === undefined ? {} : { note });

  if (context.json) {
    printJson(context, { application: updated, history: repos.applications.history(application.id) });
    return ExitCode.Ok;
  }

  printLine(context, `${job.companyName} — ${job.title}: ${application.currentStatus} → ${status}`);
  printLine(context, '  History is append-only; the previous state is still on record.');

  return ExitCode.Ok;
}

function note(context: CommandContext): ExitCodeValue {
  const reference = context.args.positionals[1];
  const text = context.args.positionals.slice(2).join(' ');

  if (!reference || text.trim().length === 0) {
    throw new UsageError('usage: roleeye apply note <job-id> "<text>"');
  }

  const { repos } = context.openDb();
  const job = resolveJob(repos, reference);
  const created = addNote(repos, job, text.trim());

  if (context.json) {
    printJson(context, created);
    return ExitCode.Ok;
  }

  printLine(context, `Noted against ${job.companyName} — ${job.title}.`);
  return ExitCode.Ok;
}

function skip(context: CommandContext): ExitCodeValue {
  const reference = context.args.positionals[1];
  if (!reference) throw new UsageError('usage: roleeye apply skip <job-id> [--reason "<why>"]');

  const { repos } = context.openDb();
  const job = resolveJob(repos, reference);
  const reason = flagString(context.args, 'reason');
  const result = skipRole(repos, job, reason === undefined ? {} : { reason });

  if (context.json) {
    printJson(context, result);
    return ExitCode.Ok;
  }

  printLine(context, `Recorded that you passed on ${job.companyName} — ${job.title}.`);
  if (result.overrode) {
    printLine(context, `  It was recommended (${result.decision}). Why you passed is worth more than why you applied.`);
  }

  return ExitCode.Ok;
}

function list(context: CommandContext): ExitCodeValue {
  const { repos } = context.openDb();
  const open = flagBool(context.args, 'open');
  const applications = repos.applications.list({ open, limit: 100 });
  const summary = pipelineSummary(repos);

  if (context.json) {
    printJson(context, { summary, applications });
    return ExitCode.Ok;
  }

  printLine(context, `Applications — ${summary.open} open`);
  printLine(context);

  if (applications.length === 0) {
    printLine(context, '  Nothing recorded yet. After you apply: roleeye apply record <job-id>');
    if (summary.awaitingDecision > 0) {
      printLine(context, `  ${summary.awaitingDecision} recommended role(s) are waiting for a decision.`);
    }
    return ExitCode.Ok;
  }

  for (const application of applications) {
    const job = repos.jobs.findById(application.jobId);
    const when = (application.appliedAt ?? application.createdAt).slice(0, 10);
    printLine(
      context,
      `  ${when}  ${application.currentStatus.padEnd(16)} ${truncate(job?.companyName ?? '(unknown)', 18).padEnd(18)} ${truncate(job?.title ?? '', 44)}`,
    );
  }

  if (summary.overrides.length > 0) {
    printLine(context);
    printLine(context, `  Overrides recorded: ${summary.overrides.map((entry) => `${entry.kind} ${entry.count}`).join(', ')}`);
  }

  return ExitCode.Ok;
}

function show(context: CommandContext): ExitCodeValue {
  const reference = context.args.positionals[1];
  if (!reference) throw new UsageError('usage: roleeye apply show <job-id>');

  const { repos } = context.openDb();
  const job = resolveJob(repos, reference);
  const application = repos.applications.findByJob(job.id);

  if (!application) throw new NotFoundError(`no application recorded for ${job.id}`);

  const history = repos.applications.history(application.id);
  const notes = repos.notes.listForJob(job.id);
  const feedback = repos.applications.feedbackForJob(job.id);

  if (context.json) {
    printJson(context, { application, history, notes, feedback });
    return ExitCode.Ok;
  }

  printLine(context, `${job.companyName} — ${job.title}`);
  printLine(context, `  status:  ${application.currentStatus}`);
  if (application.applicationUrl) printLine(context, `  url:     ${application.applicationUrl}`);
  if (application.decisionAtApply) {
    printLine(context, `  advised: ${application.decisionAtApply}${application.scoreAtApply !== undefined ? ` (${Math.round(application.scoreAtApply)})` : ''}`);
  }
  if (application.archetypeId) printLine(context, `  resume:  ${application.archetypeId}`);

  printLine(context);
  printLine(context, '  History');
  for (const event of history) {
    printLine(context, `    ${event.occurredAt.slice(0, 16).replace('T', ' ')}  ${event.fromStatus ?? '—'} → ${event.toStatus}${event.notes ? `  ${event.notes}` : ''}`);
  }

  if (notes.length > 0) {
    printLine(context);
    printLine(context, '  Notes');
    for (const entry of notes) printLine(context, `    ${entry.createdAt.slice(0, 10)}  ${entry.text}`);
  }

  if (feedback.some((entry) => entry.kind !== 'agreed')) {
    printLine(context);
    printLine(context, '  You overrode the recommendation here.');
  }

  return ExitCode.Ok;
}

function listAnswers(context: CommandContext): ExitCodeValue {
  const { repos } = context.openDb();
  const answers = repos.answers.list();

  if (context.json) {
    printJson(context, answers);
    return ExitCode.Ok;
  }

  if (answers.length === 0) {
    printLine(context, 'No stored answers yet.');
    printLine(context);
    printLine(context, '  Store one with:');
    printLine(context, '    roleeye apply answer "Notice period?" --value "Four weeks"');
    return ExitCode.Ok;
  }

  printLine(context, 'Application answers');
  printLine(context);

  for (const answer of answers) {
    const marks = [
      answer.sensitive ? 'protected' : undefined,
      answer.scope === 'universal' ? undefined : `${answer.scope}:${answer.scopeValue ?? ''}`,
      answer.confirmedAt ? undefined : answer.requiresConfirmation ? 'needs confirmation' : undefined,
      answer.expiresAt ? `expires ${answer.expiresAt.slice(0, 10)}` : undefined,
    ].filter(Boolean);

    printLine(context, `  ${truncate(answer.questionText, 58)}`);
    printLine(context, `      ${answer.answer ? truncate(answer.answer, 70) : '(unanswered)'}`);
    printLine(context, `      ${answer.provenance} · ${answer.transformation}${marks.length > 0 ? ` · ${marks.join(' · ')}` : ''}`);
  }

  return ExitCode.Ok;
}

function setAnswer(context: CommandContext): ExitCodeValue {
  const question = context.args.positionals[1];
  if (!question) {
    throw new UsageError('usage: roleeye apply answer "<question>" --value "<answer>" [--scope employer:Acme] [--expires 2027-01-01]');
  }

  const { repos } = context.openDb();
  const value = flagString(context.args, 'value');
  const scopeRaw = flagString(context.args, 'scope');
  const [scope, scopeValue] = scopeRaw ? scopeRaw.split(':') : ['universal', undefined];

  if (!['universal', 'employer', 'jurisdiction', 'role'].includes(scope as string)) {
    throw new UsageError(`unknown scope "${scope}". One of: universal, employer:<name>, jurisdiction:<code>, role:<id>`);
  }

  const stored = repos.answers.upsert({
    questionText: question,
    answer: value,
    scope: scope as 'universal' | 'employer' | 'jurisdiction' | 'role',
    scopeValue,
    expiresAt: flagString(context.args, 'expires'),
    factIds: flagList(context.args, 'facts') ?? [],
    confirmed: flagBool(context.args, 'confirm'),
  });

  if (context.json) {
    printJson(context, stored);
    return ExitCode.Ok;
  }

  printLine(context, `Stored: ${truncate(stored.questionText, 60)}`);

  if (stored.sensitive) {
    printLine(context);
    printLine(context, '  This is a protected question. It will never be answered from a similar');
    printLine(context, '  previous answer, and it is reported as unanswered until you fill it in.');
    if (!stored.confirmedAt) printLine(context, '  Confirm it per application with --confirm.');
  }

  if (isSensitiveQuestion(question) && (stored.answer ?? '').length === 0) {
    return ExitCode.CompletedWithWarnings;
  }

  return ExitCode.Ok;
}
