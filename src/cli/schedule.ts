import { execFileSync } from 'node:child_process';
import { ExitCode, UsageError } from '../util/errors.js';
import {
  buildInstallCommand,
  buildRemoveCommand,
  buildStatusCommand,
  detectScheduler,
  mergeCrontab,
  removeFromCrontab,
  TASK_NAME,
  type ScheduleCommand,
} from '../schedule/os-scheduler.js';
import { flagBool, flagString } from './args.js';
import { printJson, printLine, type Command, type CommandContext } from './command.js';

function run(command: ScheduleCommand, input?: string): string {
  const [executable, ...args] = command.argv;
  if (!executable) throw new Error('empty scheduler command');

  return execFileSync(executable, args, {
    encoding: 'utf8',
    // Capture stderr rather than letting the scheduler's own error text leak
    // past our message; "task not found" is a normal state we report ourselves.
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(input === undefined ? {} : { input }),
  });
}

function readCrontab(): string {
  try {
    return execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    // No crontab yet is a normal state, not an error.
    return '';
  }
}

/**
 * Registers the daily run with the operating system's scheduler.
 *
 * RoleEye should work for someone who never opens a terminal again after setup,
 * which means scheduling has to be one command rather than a documentation page
 * about cron syntax. `--print` shows exactly what would be run first.
 */
export const scheduleCommand: Command = {
  name: 'schedule',
  summary: 'Install, inspect, or remove the scheduled daily run',
  usage: 'roleeye schedule <install|status|remove> [--at HH:MM] [--command "scan"] [--print] [--json]',

  run(context: CommandContext) {
    const action = context.args.positionals[0] ?? 'status';
    const printOnly = flagBool(context.args, 'print');
    const kind = detectScheduler();

    if (!['install', 'status', 'remove'].includes(action)) {
      throw new UsageError(`unknown action "${action}". Usage: ${scheduleCommand.usage}`);
    }

    const config = context.loadConfig({ allowDefaults: true });
    const taskName = flagString(context.args, 'name') ?? TASK_NAME;

    if (action === 'install') {
      const command = buildInstallCommand({
        time: flagString(context.args, 'at') ?? '07:30',
        command: flagString(context.args, 'command') ?? 'scan',
        root: config.env.paths.root,
        nodePath: process.execPath,
        taskName,
      });

      if (printOnly) {
        if (context.json) printJson(context, command);
        else {
          printLine(context, `Would install with ${kind === 'windows' ? 'Task Scheduler' : 'cron'}:`);
          printLine(context);
          printLine(context, `  ${command.display}`);
        }
        return ExitCode.Ok;
      }

      if (command.kind === 'cron' && command.cronLine) {
        run(command, mergeCrontab(readCrontab(), command.cronLine, taskName));
      } else {
        run(command);
      }

      printLine(context, `Scheduled "${taskName}" daily at ${flagString(context.args, 'at') ?? '07:30'}.`);
      printLine(context, 'Check it with `roleeye schedule status`, remove it with `roleeye schedule remove`.');
      return ExitCode.Ok;
    }

    if (action === 'remove') {
      const command = buildRemoveCommand(taskName);

      if (printOnly) {
        printLine(context, `  ${command.display}`);
        return ExitCode.Ok;
      }

      if (command.kind === 'cron') {
        const current = readCrontab();
        if (!current.includes(`# ${taskName}`)) {
          printLine(context, 'Nothing scheduled.');
          return ExitCode.Ok;
        }
        run(command, removeFromCrontab(current, taskName));
      } else {
        try {
          run(command);
        } catch {
          printLine(context, 'Nothing scheduled.');
          return ExitCode.Ok;
        }
      }

      printLine(context, `Removed "${taskName}".`);
      return ExitCode.Ok;
    }

    const command = buildStatusCommand(taskName);
    if (printOnly) {
      printLine(context, `  ${command.display}`);
      return ExitCode.Ok;
    }

    let output: string;
    try {
      output = run(command);
    } catch {
      printLine(context, 'Nothing scheduled. Install with `roleeye schedule install --at 07:30`.');
      return ExitCode.Ok;
    }

    const relevant =
      command.kind === 'cron'
        ? output
            .split('\n')
            .filter((line) => line.includes(`# ${taskName}`))
            .join('\n')
        : output.trim();

    if (relevant.trim().length === 0) {
      printLine(context, 'Nothing scheduled. Install with `roleeye schedule install --at 07:30`.');
      return ExitCode.Ok;
    }

    if (context.json) {
      printJson(context, { scheduler: kind, taskName, detail: relevant });
      return ExitCode.Ok;
    }

    printLine(context, `Scheduled with ${kind === 'windows' ? 'Task Scheduler' : 'cron'}:`);
    printLine(context);
    for (const line of relevant.split('\n').slice(0, 20)) printLine(context, `  ${line}`);

    return ExitCode.Ok;
  },
};
