import { ExitCode } from '../util/errors.js';
import { isPipelineStage, PIPELINE_STAGES, runPipeline, type PipelineStage } from '../core/pipeline.js';
import { flagBool, flagList, flagNumber } from './args.js';
import { printJson, printLine, type Command, type CommandContext } from './command.js';

/**
 * The whole daily sequence, in one command.
 *
 * `scan`, `screen` and `evaluate` remain separate because each is useful alone,
 * but running them in order is what a user actually wants every morning, and
 * having to remember the order was a way to get a confusing empty result. This
 * is also what the scheduler installs and what the portal's run button calls,
 * through the same function, so all three do the same thing.
 */
export const runCommand: Command = {
  name: 'run',
  summary: 'Scan, screen, and evaluate in one pass — the daily run',
  usage: 'roleeye run [--only <stage,...>] [--limit <n>] [--force] [--source <name>] [--json]',

  async run(context: CommandContext) {
    const config = context.loadConfig();
    const { db, repos } = context.openDb();

    const requested = flagList(context.args, 'only');
    const stages: PipelineStage[] = requested
      ? PIPELINE_STAGES.filter((stage) => requested.filter(isPipelineStage).includes(stage))
      : [...PIPELINE_STAGES];

    if (stages.length === 0) {
      printLine(context, `--only must name at least one of: ${PIPELINE_STAGES.join(', ')}`);
      return ExitCode.UsageError;
    }

    // Ctrl+C asks the run to stop at the next safe boundary instead of killing
    // it: a source mid-fetch would leave its run row open, and a role mid-
    // assessment would waste a call the user has already paid for. A second
    // one has to actually work, though — this listener suppresses Node's
    // default exit, so without removing it "press again to force" would be a
    // promise the program could not keep.
    const controller = new AbortController();
    const interrupt = (): void => {
      if (controller.signal.aborted) {
        printLine(context, '');
        printLine(context, 'Forcing exit. Work already committed is saved; the current step is not.');
        process.off('SIGINT', interrupt);
        process.exit(ExitCode.CompletedWithWarnings);
      }

      printLine(context, '');
      printLine(context, 'Stopping after the current step. Press Ctrl+C again to force.');
      controller.abort();
    };
    process.on('SIGINT', interrupt);

    const limit = flagNumber(context.args, 'limit');
    const only = flagList(context.args, 'source');

    try {
      const result = await runPipeline({
        config,
        db,
        repos,
        logger: context.logger,
        stages,
        ...(limit === undefined ? {} : { limit }),
        ...(flagBool(context.args, 'force') ? { force: true } : {}),
        ...(only ? { only } : {}),
        signal: controller.signal,
        onEvent: (event) => {
          if (context.json) return;
          if (event.kind === 'stage-start') {
            printLine(context, '');
            printLine(context, `${event.stage.toUpperCase()}  ${event.message}`);
            return;
          }
          if (event.kind === 'progress') {
            const counter = event.total === undefined ? '' : ` [${event.done}/${event.total}]`;
            printLine(context, `  ${event.message}${counter}`);
            return;
          }
          printLine(context, `  ${event.kind === 'stage-failed' ? 'failed: ' : ''}${event.message}`);
        },
      });

      if (context.json) {
        printJson(context, result);
      } else if (result.status === 'busy') {
        printLine(context, result.errors[0]?.message ?? 'Another RoleEye run is in progress.');
        printLine(context, 'Nothing was changed. Wait for it to finish, or stop it, then try again.');
      } else {
        printLine(context);
        for (const warning of result.warnings) {
          printLine(context, `Warning — ${warning.stage}: ${warning.message}`);
        }
        printLine(
          context,
          result.status === 'cancelled'
            ? 'Stopped. Everything completed before you stopped it is saved.'
            : result.errors.length === 0
              ? 'Done. Review what it found with `roleeye ui`, or `roleeye recommend`.'
              : `Finished with problems: ${result.errors.map((entry) => `${entry.stage} — ${entry.message}`).join('; ')}`,
        );
      }

      // A refusal is not a failure of this invocation — the work is being done
      // by whoever holds the lock — but it is not a clean run either. A
      // scheduled task that keeps colliding with a portal session must be
      // visible, not recorded as a success that quietly did nothing.
      if (result.status === 'busy') return ExitCode.CompletedWithWarnings;
      if (result.status === 'failed') return ExitCode.UnexpectedError;
      if (result.status === 'warning') return ExitCode.CompletedWithWarnings;
      return ExitCode.Ok;
    } finally {
      process.off('SIGINT', interrupt);
    }
  },
};
