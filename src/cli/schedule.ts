import { ExitCode, UsageError } from '../util/errors.js';
import { checkBuild, installSchedule, readSchedule, removeSchedule } from '../schedule/inspect.js';
import { buildInstallCommand, buildRemoveCommand, detectScheduler, TASK_NAME } from '../schedule/os-scheduler.js';
import { flagBool, flagString } from './args.js';
import { printJson, printLine, type Command, type CommandContext } from './command.js';

/**
 * Registers the daily run with the operating system's scheduler.
 *
 * RoleEye should work for someone who never opens a terminal again after setup,
 * which means scheduling has to be one command rather than a documentation page
 * about cron syntax. `--print` shows exactly what would be run first.
 *
 * Every action delegates to `schedule/inspect.ts`, the same module the portal
 * calls. This command used to build and run its own scheduler commands, so the
 * terminal and the portal could disagree about what was installed — and the
 * terminal missed the check that refuses to schedule a command the build cannot
 * run.
 */
export const scheduleCommand: Command = {
  name: 'schedule',
  summary: 'Install, inspect, or remove the scheduled daily run',
  usage: 'roleeye schedule <install|status|remove> [--at HH:MM] [--command "run"] [--print] [--json]',

  run(context: CommandContext) {
    const action = context.args.positionals[0] ?? 'status';
    const printOnly = flagBool(context.args, 'print');
    const kind = detectScheduler();

    if (!['install', 'status', 'remove'].includes(action)) {
      throw new UsageError(`unknown action "${action}". Usage: ${scheduleCommand.usage}`);
    }

    const config = context.loadConfig({ allowDefaults: true });
    const taskName = flagString(context.args, 'name') ?? TASK_NAME;
    const schedulerName = kind === 'windows' ? 'Task Scheduler' : 'cron';

    if (action === 'install') {
      // `run` is the whole daily pass. This defaulted to `scan`, which fetches
      // postings and then never screens or assesses them — so the user wakes up
      // to a review queue that never fills and no reason why.
      const at = flagString(context.args, 'at') ?? '07:30';
      const command = flagString(context.args, 'command') ?? 'run';
      const spec = { time: at, command, root: config.env.paths.root, nodePath: process.execPath, taskName };

      if (printOnly) {
        const preview = buildInstallCommand(spec);
        if (context.json) printJson(context, preview);
        else {
          printLine(context, `Would install with ${schedulerName}:`);
          printLine(context);
          printLine(context, `  ${preview.display}`);
        }
        return ExitCode.Ok;
      }

      const schedule = installSchedule(spec);

      if (context.json) {
        printJson(context, schedule);
        return ExitCode.Ok;
      }

      printLine(context, `Scheduled "${taskName}" daily at ${schedule.at ?? at}, running "${command}".`);
      if (schedule.nextRun) printLine(context, `Next run ${schedule.nextRun}.`);
      if (schedule.staleBuild) {
        printLine(context);
        printLine(context, 'The build is older than the source. Run `npm run build`, or the scheduled run uses old code.');
      }
      printLine(context, 'Check it with `roleeye schedule status`, remove it with `roleeye schedule remove`.');
      return ExitCode.Ok;
    }

    if (action === 'remove') {
      if (printOnly) {
        printLine(context, `  ${buildRemoveCommand(taskName).display}`);
        return ExitCode.Ok;
      }

      const result = removeSchedule(taskName);

      if (context.json) {
        printJson(context, result);
        return ExitCode.Ok;
      }

      printLine(context, result.removed ? `Removed "${taskName}".` : 'Nothing scheduled.');
      return ExitCode.Ok;
    }

    const schedule = readSchedule(taskName);
    const build = checkBuild(config.env.paths.root);

    if (context.json) {
      printJson(context, { ...schedule, build });
      return ExitCode.Ok;
    }

    if (!schedule.installed) {
      printLine(context, 'Nothing scheduled. Install with `roleeye schedule install --at 07:30`.');
      return ExitCode.Ok;
    }

    printLine(context, `Scheduled with ${schedulerName}:`);
    printLine(context);
    if (schedule.nextRun) printLine(context, `  Next run    ${schedule.nextRun}`);
    if (schedule.at) printLine(context, `  Daily at    ${schedule.at}`);
    if (schedule.command) printLine(context, `  Runs        roleeye ${schedule.command}`);

    if (!build.exists) {
      printLine(context);
      printLine(context, '  There is no build for it to run. Run `npm run build`.');
    } else if (build.stale) {
      printLine(context);
      printLine(context, '  The build is older than the source, so it would run old code. Run `npm run build`.');
    }

    if (schedule.detail) {
      printLine(context);
      for (const line of schedule.detail.split('\n').slice(0, 20)) printLine(context, `  ${line}`);
    }

    return ExitCode.Ok;
  },
};
