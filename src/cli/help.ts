import { ExitCode } from '../util/errors.js';
import { doctorCommand } from './doctor.js';
import { initCommand } from './init.js';
import { listCommand } from './list.js';
import { scanCommand } from './scan.js';
import { showCommand } from './show.js';
import { printLine, type Command, type CommandContext } from './command.js';

export const commands: readonly Command[] = [
  initCommand,
  doctorCommand,
  scanCommand,
  listCommand,
  showCommand,
];

export function findCommand(name: string | undefined): Command | undefined {
  if (!name) return undefined;
  return commands.find((command) => command.name === name);
}

/** Commands documented in agent.md that later phases will implement. */
const PLANNED: ReadonlyArray<readonly [string, string]> = [
  ['evaluate', 'phase 3'],
  ['recommend', 'phase 3'],
  ['resume', 'phase 4'],
  ['apply-record', 'phase 5'],
  ['status', 'phase 5'],
  ['note', 'phase 5'],
  ['stats', 'phase 6'],
  ['ask', 'phase 7'],
  ['export', 'phase 8'],
  ['sync', 'phase 8'],
];

export function isPlannedCommand(name: string): boolean {
  return PLANNED.some(([command]) => command === name);
}

export function plannedPhase(name: string): string | undefined {
  return PLANNED.find(([command]) => command === name)?.[1];
}

export function printHelp(context: CommandContext, commandName?: string): void {
  const command = findCommand(commandName);

  if (command) {
    printLine(context, command.summary);
    printLine(context);
    printLine(context, `Usage: ${command.usage}`);
    return;
  }

  printLine(context, 'roleeye — local-first career agent');
  printLine(context);
  printLine(context, 'Usage: roleeye <command> [options]');
  printLine(context);
  printLine(context, 'Commands:');
  for (const entry of commands) {
    printLine(context, `  ${entry.name.padEnd(10)} ${entry.summary}`);
  }
  printLine(context);
  printLine(context, 'Planned (not implemented yet):');
  for (const [name, phase] of PLANNED) {
    printLine(context, `  ${name.padEnd(14)} ${phase}`);
  }
  printLine(context);
  printLine(context, 'Global options:');
  printLine(context, '  --json          machine-readable output');
  printLine(context, '  --log-level     error | warn | info | debug');
  printLine(context, '  --version       print version');
  printLine(context, '  --help          print this help, or help for a command');
  printLine(context);
  printLine(context, 'Exit codes:');
  printLine(context, `  ${ExitCode.Ok} ok   ${ExitCode.UnexpectedError} error   ${ExitCode.UsageError} usage   ${ExitCode.ConfigError} config   ${ExitCode.NotFound} not found   ${ExitCode.CompletedWithWarnings} completed with warnings`);
}
