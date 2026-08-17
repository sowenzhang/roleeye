import { ExitCode } from '../util/errors.js';
import { addCommand } from './add.js';
import { askCommand } from './ask.js';
import { backupCommand } from './backup.js';
import { doctorCommand } from './doctor.js';
import { evaluateCommand } from './evaluate.js';
import { initCommand } from './init.js';
import { listCommand } from './list.js';
import { recommendCommand, statsCommand } from './recommend.js';
import { digestCommand } from './digest.js';
import { resumeCommand } from './resume.js';
import { applyCommand } from './apply.js';
import { scanCommand } from './scan.js';
import { runCommand } from './run.js';
import { scheduleCommand } from './schedule.js';
import { scopeCommand } from './scope.js';
import { screenCommand } from './screen.js';
import { searchCommand } from './search.js';
import { showCommand } from './show.js';
import { uiCommand } from './ui.js';
import { verifyCommand } from './verify.js';
import { printLine, type Command, type CommandContext } from './command.js';

export const commands: readonly Command[] = [
  initCommand,
  uiCommand,
  doctorCommand,
  runCommand,
  scanCommand,
  addCommand,
  scopeCommand,
  screenCommand,
  evaluateCommand,
  recommendCommand,
  digestCommand,
  resumeCommand,
  applyCommand,
  verifyCommand,
  searchCommand,
  askCommand,
  listCommand,
  showCommand,
  statsCommand,
  scheduleCommand,
  backupCommand,
];

export function findCommand(name: string | undefined): Command | undefined {
  if (!name) return undefined;
  return commands.find((command) => command.name === name);
}

/** Commands documented in agent.md that later phases will implement. */
const PLANNED: ReadonlyArray<readonly [string, string]> = [];

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
  // A wall of twenty commands answers "what can it do" and not "what do I type
  // now", which is the only question somebody running it for the first time has.
  printLine(context, 'Start here:');
  printLine(context, '  roleeye ui        pick companies and preferences in a browser');
  printLine(context, '  roleeye run       the daily pass: scan, screen, then evaluate');
  printLine(context, '  roleeye scan      fetch what those companies have posted');
  printLine(context, '  roleeye screen    apply your rules and check for ghost jobs');
  printLine(context);
  printLine(context, '  From this checkout: npm run ui, or npm run roleeye -- scan');
  printLine(context);
  printLine(context, 'Commands:');
  for (const entry of commands) {
    printLine(context, `  ${entry.name.padEnd(10)} ${entry.summary}`);
  }
  printLine(context);
  if (PLANNED.length > 0) {
    printLine(context, 'Planned (not implemented yet):');
    for (const [name, phase] of PLANNED) {
      printLine(context, `  ${name.padEnd(14)} ${phase}`);
    }
    printLine(context);
  }
  printLine(context, 'Global options:');
  printLine(context, '  --json          machine-readable output');
  printLine(context, '  --log-level     error | warn | info | debug');
  printLine(context, '  --version       print version');
  printLine(context, '  --help          print this help, or help for a command');
  printLine(context);
  printLine(context, 'Exit codes:');
  printLine(context, `  ${ExitCode.Ok} ok   ${ExitCode.UnexpectedError} error   ${ExitCode.UsageError} usage   ${ExitCode.ConfigError} config   ${ExitCode.NotFound} not found   ${ExitCode.CompletedWithWarnings} completed with warnings`);
}
