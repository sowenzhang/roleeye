import { ExitCode } from '../util/errors.js';
import { truncate } from '../normalize/text.js';
import { flagBool, flagNumber, flagString } from './args.js';
import { printJson, printLine, type Command, type CommandContext } from './command.js';

/**
 * Structured listing of stored jobs. This is plain SQL filtering — semantic
 * search arrives in a later phase and must not replace it.
 */
export const listCommand: Command = {
  name: 'list',
  summary: 'List stored jobs with structured filters',
  usage:
    'roleeye list [--company <name>] [--title <text>] [--department <text>] [--source <type>] [--country <code>] [--since <iso-date>] [--include-closed] [--include-out-of-scope] [--limit <n>] [--json]',

  run(context: CommandContext) {
    const { repos } = context.openDb();

    const since = flagString(context.args, 'since');
    const includeOutOfScope = flagBool(context.args, 'include-out-of-scope');
    const jobs = repos.jobs.list({
      company: flagString(context.args, 'company'),
      titleContains: flagString(context.args, 'title'),
      sourceType: flagString(context.args, 'source'),
      country: flagString(context.args, 'country'),
      department: flagString(context.args, 'department'),
      seenSince: since ? new Date(since).toISOString() : undefined,
      includeClosed: flagBool(context.args, 'include-closed'),
      inScope: includeOutOfScope ? undefined : true,
      limit: flagNumber(context.args, 'limit') ?? 50,
      offset: flagNumber(context.args, 'offset') ?? 0,
    });

    if (context.json) {
      printJson(
        context,
        jobs.map((job) => ({
          id: job.id,
          company: job.companyName,
          title: job.title,
          level: job.level,
          location: job.locationText,
          workArrangement: job.workArrangement,
          firstSeenAt: job.firstSeenAt,
          lastSeenAt: job.lastSeenAt,
          url: job.canonicalUrl ?? job.sourceUrl,
        })),
      );
      return ExitCode.Ok;
    }

    if (jobs.length === 0) {
      printLine(context, 'No jobs match. Run `roleeye scan` first, or relax the filters.');
      return ExitCode.Ok;
    }

    printLine(context, `${jobs.length} job(s)`);
    printLine(context);
    for (const job of jobs) {
      printLine(
        context,
        `  ${job.id}  ${truncate(job.companyName, 22).padEnd(22)} ${truncate(job.title, 46).padEnd(46)} ${job.firstSeenAt.slice(0, 10)}`,
      );
    }

    return ExitCode.Ok;
  },
};
