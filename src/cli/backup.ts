import path from 'node:path';
import { ExitCode } from '../util/errors.js';
import { backupDatabase, backupDirectoryFor } from '../util/backup.js';
import { flagNumber, flagString } from './args.js';
import { printJson, printLine, type Command, type CommandContext } from './command.js';

/**
 * Snapshots the authoritative database.
 *
 * Everything this tool promises — permanent history, nothing ever deleted —
 * rests on one file. A backup is also taken automatically before any migration.
 */
export const backupCommand: Command = {
  name: 'backup',
  summary: 'Snapshot the local database',
  usage: 'roleeye backup [--to <directory>] [--keep <n>] [--json]',

  run(context: CommandContext) {
    const config = context.loadConfig({ allowDefaults: true });
    const dbPath = config.env.paths.dbPath;

    // Ensure the schema is current before snapshotting, so the copy is usable.
    context.openDb();

    const result = backupDatabase({
      dbPath,
      directory: flagString(context.args, 'to'),
      keep: flagNumber(context.args, 'keep') ?? 10,
      logger: context.logger,
    });

    if (context.json) {
      printJson(context, { ...result, directory: backupDirectoryFor(dbPath, flagString(context.args, 'to')) });
      return ExitCode.Ok;
    }

    if (result.skipped) {
      printLine(context, 'No database to back up yet. Run `roleeye scan` first.');
      return ExitCode.Ok;
    }

    printLine(context, `Backed up to ${path.relative(context.root, result.path)}`);
    printLine(context, `${(result.bytes / 1024).toFixed(0)} KB`);
    return ExitCode.Ok;
  },
};
