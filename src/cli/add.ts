import { ExitCode, UsageError } from '../util/errors.js';
import { withTransaction } from '../db/database.js';
import { captureFromUrl } from '../discovery/capture.js';
import { createHttpClient } from '../discovery/http.js';
import { ingestJob } from '../discovery/ingest.js';
import { nowIso } from '../util/time.js';
import { flagBool, flagString } from './args.js';
import { printJson, printLine, type Command, type CommandContext } from './command.js';

/**
 * Captures a posting the configured sources do not reach — a link from a
 * recruiter, a friend, or an aggregator.
 *
 * Manual capture bypasses the scope filter by design: the user asked for this
 * specific role, so scope has already been applied by a human.
 */
export const addCommand: Command = {
  name: 'add',
  summary: 'Capture a single job posting from a URL',
  usage: 'roleeye add <url> [--company <name>] [--dry-run] [--json]',

  async run(context: CommandContext) {
    const url = context.args.positionals[0];
    if (!url) throw new UsageError('missing URL. Usage: roleeye add <url>');

    const config = context.loadConfig({ allowDefaults: true });
    const { db, repos } = context.openDb();
    const dryRun = flagBool(context.args, 'dry-run');

    const http = createHttpClient({
      userAgent: config.sources.defaults.user_agent,
      timeoutMs: config.sources.defaults.timeout_ms,
      delayMs: config.sources.defaults.request_delay_ms,
      logger: context.logger,
    });

    const discovered = await captureFromUrl(url, {
      http,
      logger: context.logger,
      company: flagString(context.args, 'company'),
      sourceName: 'manual',
    });

    if (dryRun) {
      if (context.json) {
        printJson(context, { captured: discovered.length, jobs: discovered.map(summarize) });
      } else {
        printLine(context, `Would capture ${discovered.length} posting(s):`);
        for (const job of discovered) printLine(context, `  ${job.companyName} — ${job.title}`);
      }
      return ExitCode.Ok;
    }

    const seenAt = nowIso();
    const results = withTransaction(db, () =>
      discovered.map((job) =>
        ingestJob(repos, job, {
          seenAt,
          scanId: undefined,
          repostGapDays: config.sources.dedupe.repost_gap_days,
          captureMode: 'full',
          scope: undefined,
          // A human chose this URL, so scope has already been applied.
          ignoreScope: true,
        }),
      ),
    );

    const stored = results.filter((result) => result.jobId !== undefined);

    if (context.json) {
      printJson(
        context,
        stored.map((result) => ({ jobId: result.jobId, postingId: result.postingId, outcome: result.outcome })),
      );
      return ExitCode.Ok;
    }

    for (const result of stored) {
      const job = result.jobId ? repos.jobs.findById(result.jobId) : undefined;
      printLine(
        context,
        `${result.outcome === 'new' ? 'Captured' : 'Already known'}: ${job?.companyName ?? ''} — ${job?.title ?? ''}`,
      );
      printLine(context, `  ${result.jobId}`);
    }

    printLine(context);
    printLine(context, 'View it with `roleeye show <job-id>`.');
    return ExitCode.Ok;
  },
};

function summarize(job: { companyName: string; title: string; url: string; location?: string | undefined }) {
  return { company: job.companyName, title: job.title, location: job.location, url: job.url };
}
