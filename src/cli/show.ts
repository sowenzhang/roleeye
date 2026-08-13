import { ExitCode, NotFoundError, UsageError } from '../util/errors.js';
import type { JobRecord } from '../db/repositories/jobs.js';
import type { SourcePosting } from '../db/repositories/source-postings.js';
import type { Repositories } from '../db/repositories/index.js';
import { truncate } from '../normalize/text.js';
import { flagBool, flagNumber } from './args.js';
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

function formatSalary(job: JobRecord): string {
  if (job.salaryMin === undefined && job.salaryMax === undefined) return 'not stated';

  const currency = job.salaryCurrency ?? 'USD';
  const period = job.salaryPeriod ?? 'year';
  const format = (value: number): string => value.toLocaleString('en-US');

  if (job.salaryMin !== undefined && job.salaryMax !== undefined && job.salaryMin !== job.salaryMax) {
    return `${currency} ${format(job.salaryMin)} - ${format(job.salaryMax)} / ${period}`;
  }
  return `${currency} ${format(job.salaryMin ?? job.salaryMax ?? 0)} / ${period}`;
}

/** One line per source advertising the role, including retired ones. */
function describePosting(posting: SourcePosting): string {
  const parts = [
    posting.sourceType,
    posting.sourceName ? `/ ${posting.sourceName}` : '',
    `[${posting.captureMode}]`,
    posting.locationText ? `— ${posting.locationText}` : '',
    posting.closedAt ? `— closed ${posting.closedAt.slice(0, 10)}` : '',
  ];
  return parts.filter((part) => part.length > 0).join(' ');
}

/** Shows the full local record for one job: metadata, history, and snapshots. */
export const showCommand: Command = {
  name: 'show',
  summary: 'Show the stored record and history for one job',
  usage: 'roleeye show <job-id> [--full] [--description-lines <n>] [--json]',

  run(context: CommandContext) {
    const reference = context.args.positionals[0];
    if (!reference) throw new UsageError('missing job id. Usage: roleeye show <job-id>');

    const { repos } = context.openDb();
    const job = resolveJob(repos, reference);

    const postings = repos.postings.listForJob(job.id);
    const events = repos.events.listForJob(job.id);
    const snapshots = repos.snapshots.listForJob(job.id);
    const reposts = events.filter((event) => event.eventType === 'reposted');

    if (context.json) {
      printJson(context, {
        job,
        postings,
        reposts: reposts.map((event) => ({ seenAt: event.seenAt, detail: event.detail })),
        events: events.map((event) => ({
          seenAt: event.seenAt,
          eventType: event.eventType,
          sourceType: event.sourceType,
          detail: event.detail,
        })),
        snapshots: snapshots.map((snapshot) => ({
          capturedAt: snapshot.capturedAt,
          descriptionHash: snapshot.descriptionHash,
          length: snapshot.normalizedDescription.length,
        })),
      });
      return ExitCode.Ok;
    }

    const full = flagBool(context.args, 'full');
    const descriptionLines = flagNumber(context.args, 'description-lines') ?? (full ? Number.MAX_SAFE_INTEGER : 12);

    printLine(context, `${job.companyName} — ${job.title}`);
    printLine(context, `${job.id}`);
    printLine(context);
    printLine(context, `  Level:        ${job.level ?? 'unspecified'}`);
    printLine(context, `  Team:         ${[job.department, job.team].filter(Boolean).join(' / ') || 'unspecified'}`);
    printLine(context, `  Location:     ${job.locationText ?? 'unspecified'}${job.country ? ` (${job.country})` : ''}`);
    printLine(context, `  Arrangement:  ${job.workArrangement}`);
    printLine(context, `  Compensation: ${formatSalary(job)}`);
    printLine(context, `  Scope:        ${job.inScope ? 'in scope' : `out of scope (${job.scopeReason ?? 'unspecified'})`}`);
    printLine(context, `  First seen:   ${job.firstSeenAt}`);
    printLine(context, `  Last seen:    ${job.lastSeenAt}`);
    printLine(context, `  Status:       ${job.closedAt ? `closed ${job.closedAt}` : 'open'}`);
    printLine(context, `  Snapshots:    ${snapshots.length}`);

    printLine(context);
    printLine(context, `  Advertised by ${postings.length} source${postings.length === 1 ? '' : 's'}:`);
    for (const posting of postings) {
      printLine(context, `    ${describePosting(posting)}`);
      printLine(context, `      ${posting.canonicalUrl ?? posting.sourceUrl}`);
    }

    printLine(context);
    printLine(context, '  History:');
    for (const event of events.slice(-10)) {
      printLine(context, `    ${event.seenAt}  ${event.eventType}${event.detail ? ` — ${event.detail}` : ''}`);
    }

    if (job.descriptionText.length > 0) {
      printLine(context);
      printLine(context, '  Description:');
      const lines = job.descriptionText.split('\n');
      for (const line of lines.slice(0, descriptionLines)) {
        printLine(context, `    ${truncate(line, 140)}`);
      }
      if (lines.length > descriptionLines) {
        printLine(context, `    … ${lines.length - descriptionLines} more lines (use --full)`);
      }
    }

    return ExitCode.Ok;
  },
};
