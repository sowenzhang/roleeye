import { UsageError } from '../util/errors.js';

export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

/**
 * Minimal argv parser. Supports `--flag`, `--flag=value`, `--flag value`,
 * `--no-flag`, and `-short`. Everything after `--` is positional.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  let passthrough = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === '--') {
      passthrough = true;
      continue;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');

      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }

      if (body.startsWith('no-')) {
        flags.set(body.slice(3), false);
        continue;
      }

      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags.set(body, next);
        i += 1;
      } else {
        flags.set(body, true);
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      flags.set(token.slice(1), true);
      continue;
    }

    positionals.push(token);
  }

  const [command, ...rest] = positionals;
  return { command, positionals: rest, flags };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === undefined || typeof value === 'boolean') return undefined;
  return value;
}

export function flagBool(args: ParsedArgs, name: string, fallback = false): boolean {
  const value = args.flags.get(name);
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return value !== 'false' && value !== '0';
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const value = flagString(args, name);
  if (value === undefined) return undefined;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new UsageError(`--${name} must be a number, received "${value}"`);
  }
  return parsed;
}

export function flagList(args: ParsedArgs, name: string): string[] | undefined {
  const value = flagString(args, name);
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
