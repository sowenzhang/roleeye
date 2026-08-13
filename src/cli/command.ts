import type { AppConfig } from '../config/load.js';
import type { Database } from '../db/database.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Logger } from '../util/logger.js';
import type { ExitCodeValue } from '../util/errors.js';
import type { ParsedArgs } from './args.js';

export interface CommandContext {
  args: ParsedArgs;
  root: string;
  logger: Logger;
  /** Machine-readable output requested via --json. */
  json: boolean;
  stdout: NodeJS.WritableStream;
  /** Lazily opens config; commands that need it call this. */
  loadConfig(options?: { allowDefaults?: boolean }): AppConfig;
  /** Lazily opens the database and runs migrations. */
  openDb(): { db: Database; repos: Repositories };
}

export interface Command {
  name: string;
  summary: string;
  usage: string;
  run(context: CommandContext): Promise<ExitCodeValue> | ExitCodeValue;
}

export function printJson(context: CommandContext, value: unknown): void {
  context.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printLine(context: CommandContext, line = ''): void {
  context.stdout.write(`${line}\n`);
}
