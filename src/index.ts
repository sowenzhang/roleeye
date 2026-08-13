#!/usr/bin/env node
import { createRequire } from 'node:module';
import { loadConfig, type AppConfig } from './config/load.js';
import { findProjectRoot } from './config/paths.js';
import { closeDatabase, openDatabase, type Database } from './db/database.js';
import { createRepositories, type Repositories } from './db/repositories/index.js';
import { ExitCode, RoleEyeError, type ExitCodeValue } from './util/errors.js';
import { createLogger, isLogLevel, type LogLevel } from './util/logger.js';
import { flagBool, flagString, parseArgs } from './cli/args.js';
import type { CommandContext } from './cli/command.js';
import { findCommand, isPlannedCommand, plannedPhase, printHelp } from './cli/help.js';

const require = createRequire(import.meta.url);

function version(): string {
  try {
    return (require('../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<ExitCodeValue> {
  const args = parseArgs(argv);
  const root = findProjectRoot();
  const json = flagBool(args, 'json');

  const requestedLevel = flagString(args, 'log-level');
  const envLevel = process.env['ROLEEYE_LOG_LEVEL']?.toLowerCase();
  const level: LogLevel =
    requestedLevel && isLogLevel(requestedLevel)
      ? requestedLevel
      : envLevel && isLogLevel(envLevel)
        ? envLevel
        : 'info';

  const logger = createLogger({ level, json });

  let db: Database | undefined;
  let cachedConfig: AppConfig | undefined;

  const context: CommandContext = {
    args,
    root,
    logger,
    json,
    stdout: process.stdout,
    loadConfig(options) {
      if (!cachedConfig || options?.allowDefaults) {
        cachedConfig = loadConfig({ root, allowDefaults: options?.allowDefaults ?? false });
      }
      return cachedConfig;
    },
    openDb(): { db: Database; repos: Repositories } {
      if (!db) {
        const config = context.loadConfig({ allowDefaults: true });
        db = openDatabase({ path: config.env.paths.dbPath, logger });
      }
      return { db, repos: createRepositories(db) };
    },
  };

  try {
    if (flagBool(args, 'version') || args.command === 'version') {
      process.stdout.write(`${version()}\n`);
      return ExitCode.Ok;
    }

    if (!args.command || args.command === 'help' || flagBool(args, 'help') || flagBool(args, 'h')) {
      const target = args.command === 'help' ? args.positionals[0] : args.command;
      printHelp(context, target);
      return args.command && args.command !== 'help' && !findCommand(args.command)
        ? ExitCode.UsageError
        : ExitCode.Ok;
    }

    const command = findCommand(args.command);

    if (!command) {
      if (isPlannedCommand(args.command)) {
        logger.error('command not implemented yet', {
          command: args.command,
          phase: plannedPhase(args.command) ?? 'later',
        });
        return ExitCode.UsageError;
      }
      logger.error('unknown command', { command: args.command });
      printHelp(context);
      return ExitCode.UsageError;
    }

    return await command.run(context);
  } catch (error) {
    if (error instanceof RoleEyeError) {
      logger.error(error.message, error.details ?? {});
      return error.exitCode;
    }
    logger.error('unexpected error', { error: error instanceof Error ? error.stack : String(error) });
    return ExitCode.UnexpectedError;
  } finally {
    if (db) closeDatabase(db);
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.startsWith('file:');

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = ExitCode.UnexpectedError;
    });
}
