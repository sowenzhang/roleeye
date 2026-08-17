import { ExitCode } from '../util/errors.js';
import { runScan } from '../discovery/scan.js';
import { withRunLock } from './with-lock.js';
import { flagBool, flagList, flagString } from './args.js';
import { printJson, printLine, type Command, type CommandContext } from './command.js';

/**
 * Daily discovery entry point. Deterministic: no LLM is involved, and repeated
 * runs against the same board are idempotent.
 */
export const scanCommand: Command = {
  name: 'scan',
  summary: 'Fetch configured job sources and record everything discovered',
  usage: 'roleeye scan [--source <name|type>] [--dry-run] [--json]',

  async run(context: CommandContext) {
    const config = context.loadConfig();
    const { db, repos } = context.openDb();

    const only = flagList(context.args, 'source') ?? (flagString(context.args, 'source') ? [flagString(context.args, 'source')!] : undefined);
    const dryRun = flagBool(context.args, 'dry-run');

    // A dry run writes nothing, so it has no reason to wait for anything else.
    if (dryRun) return execute();

    return withRunLock(context, db, 'scan', execute);

    async function execute() {
    const summary = await runScan({
      config,
      db,
      repos,
      logger: context.logger,
      only,
      dryRun,
    });

    if (context.json) {
      printJson(context, summary);
    } else {
      printLine(context, dryRun ? 'Scan (dry run)' : 'Scan');
      printLine(context);

      if (summary.sources.length === 0) {
        printLine(context, '  No enabled sources. Add one to config/sources.yaml.');
      }

      for (const source of summary.sources) {
        if (source.status === 'failed') {
          printLine(context, `  ${source.sourceName}: failed - ${source.error ?? 'unknown error'}`);
          continue;
        }
        printLine(
          context,
          `  ${source.sourceName} [${source.captureMode}]: ${source.fetched} fetched, ${source.new} new, ` +
            `${source.changed} changed, ${source.reposted} reposted, ${source.unchanged} unchanged` +
            (source.outOfScope > 0 ? `, ${source.outOfScope} out of scope` : '') +
            (source.closed > 0 ? `, ${source.closed} closed` : '') +
            (source.deferred > 0 ? `, ${source.deferred} over cap` : ''),
        );
      }

      printLine(context);
      printLine(
        context,
        summary.status === 'ok'
          ? `Scan completed. ${summary.totals.new} new, ${summary.totals.changed} changed, ${summary.totals.reposted} reposted.`
          : summary.status === 'warning'
            ? 'Scan completed with warnings.'
            : 'Scan failed: every source errored.',
      );
    }

    if (summary.status === 'failed') return ExitCode.UnexpectedError;
    if (summary.status === 'warning') return ExitCode.CompletedWithWarnings;
    return ExitCode.Ok;
    }
  },
};
