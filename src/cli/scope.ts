import { ExitCode, UsageError } from '../util/errors.js';
import { evaluateScope, isScopeEmpty, scopeFromConfig, type EffectiveScope } from '../discovery/scope.js';
import { truncate } from '../normalize/text.js';
import { flagNumber, flagString } from './args.js';
import { printJson, printLine, type Command, type CommandContext } from './command.js';

/**
 * Previews the scope filter against stored history.
 *
 * Scope decides how much of a board becomes noise and model spend, so it must
 * be inspectable before a scan rather than discovered afterwards. This command
 * only reads.
 */
export const scopeCommand: Command = {
  name: 'scope',
  summary: 'Preview which stored jobs the current scope keeps and drops',
  usage: 'roleeye scope test [--source <name>] [--show <kept|dropped|both>] [--limit <n>] [--json]',

  run(context: CommandContext) {
    const subcommand = context.args.positionals[0] ?? 'test';
    if (subcommand !== 'test') {
      throw new UsageError(`unknown subcommand "${subcommand}". Usage: ${scopeCommand.usage}`);
    }

    const config = context.loadConfig({ allowDefaults: true });
    const { repos } = context.openDb();

    const sourceName = flagString(context.args, 'source');
    const source = sourceName
      ? config.sources.sources.find((entry) => entry.name === sourceName)
      : undefined;

    if (sourceName && !source) {
      throw new UsageError(`no source named "${sourceName}" in config/sources.yaml`);
    }

    const scope: EffectiveScope = scopeFromConfig(config.sources, source?.scope);
    const captureMode = source?.capture_mode ?? config.sources.discovery.capture_mode;

    const jobs = repos.jobs.list({
      limit: flagNumber(context.args, 'limit') ?? 500,
      includeClosed: true,
      inScope: undefined,
      // Filter by the named source, not by everything sharing its provider type.
      sourceName: source?.name,
    });

    const kept: Array<{ id: string; company: string; title: string }> = [];
    const dropped: Array<{ id: string; company: string; title: string; reason: string }> = [];

    for (const job of jobs) {
      const verdict = evaluateScope(
        {
          title: job.title,
          level: job.level,
          department: job.department,
          team: job.team,
          locationText: job.locationText,
          country: job.country,
          workArrangement: job.workArrangement,
          // The real posting date when the source supplied one; discovery date
          // otherwise, which is the closest honest approximation.
          postedAt: job.postedAt ?? job.firstSeenAt,
        },
        scope,
      );

      if (verdict.inScope) {
        kept.push({ id: job.id, company: job.companyName, title: job.title });
      } else {
        dropped.push({
          id: job.id,
          company: job.companyName,
          title: job.title,
          reason: verdict.reason ?? 'out of scope',
        });
      }
    }

    if (context.json) {
      printJson(context, {
        source: sourceName ?? '(global)',
        captureMode,
        scopeConfigured: !isScopeEmpty(scope),
        evaluated: jobs.length,
        kept: kept.length,
        dropped: dropped.length,
        keptJobs: kept,
        droppedJobs: dropped,
      });
      return ExitCode.Ok;
    }

    printLine(context, `Scope preview — ${sourceName ?? 'global configuration'} [${captureMode}]`);
    printLine(context);

    if (jobs.length === 0) {
      printLine(context, '  No stored jobs yet. Run `roleeye scan` first.');
      return ExitCode.Ok;
    }

    if (isScopeEmpty(scope)) {
      printLine(context, '  No scope configured: every posting is in scope.');
      printLine(context, '  Set discovery.scope in config/sources.yaml to narrow this.');
      printLine(context);
    }

    const show = flagString(context.args, 'show') ?? 'both';
    const sample = 12;

    printLine(context, `  ${kept.length} kept, ${dropped.length} dropped, of ${jobs.length} evaluated`);

    if (show !== 'dropped' && kept.length > 0) {
      printLine(context);
      printLine(context, '  Kept:');
      for (const job of kept.slice(0, sample)) {
        printLine(context, `    ${truncate(job.company, 18).padEnd(18)} ${truncate(job.title, 52)}`);
      }
      if (kept.length > sample) printLine(context, `    … ${kept.length - sample} more`);
    }

    if (show !== 'kept' && dropped.length > 0) {
      printLine(context);
      printLine(context, '  Dropped:');
      for (const job of dropped.slice(0, sample)) {
        printLine(
          context,
          `    ${truncate(job.company, 18).padEnd(18)} ${truncate(job.title, 38).padEnd(38)} ${job.reason}`,
        );
      }
      if (dropped.length > sample) printLine(context, `    … ${dropped.length - sample} more`);
    }

    printLine(context);
    printLine(context, '  Nothing was written. Dropped roles already stored remain queryable as history.');

    return ExitCode.Ok;
  },
};
