import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isLogLevel, type LogLevel } from '../util/logger.js';

export interface Paths {
  root: string;
  configDir: string;
  profileDir: string;
  dataDir: string;
  artifactsDir: string;
  exportDir: string;
  dbPath: string;
}

export interface Environment {
  logLevel: LogLevel;
  reasoningProvider: string;
  embeddingProvider: string;
  paths: Paths;
}

/**
 * Minimal .env reader. We avoid a dependency because the file format we need is
 * trivial, and secrets must not be parsed by anything surprising.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    out[key] = value;
  }

  return out;
}

/** Loads .env without overwriting variables already set in the real environment. */
export function loadDotEnv(root: string, env: NodeJS.ProcessEnv = process.env): void {
  const file = path.join(root, '.env');
  if (!existsSync(file)) return;

  const parsed = parseDotEnv(readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value;
  }
}

function resolvePath(root: string, value: string | undefined, fallback: string): string {
  const target = value && value.trim().length > 0 ? value : fallback;
  return path.isAbsolute(target) ? target : path.resolve(root, target);
}

export function resolvePaths(root: string, env: NodeJS.ProcessEnv = process.env): Paths {
  const dataDir = resolvePath(root, env['ROLEEYE_DATA_DIR'], './data');

  return {
    root,
    configDir: resolvePath(root, env['ROLEEYE_CONFIG_DIR'], './config'),
    profileDir: resolvePath(root, env['ROLEEYE_PROFILE_DIR'], './profile'),
    dataDir,
    artifactsDir: resolvePath(root, env['ROLEEYE_ARTIFACTS_DIR'], './artifacts'),
    exportDir: resolvePath(root, env['ROLEEYE_EXPORT_DIR'], './export'),
    dbPath: resolvePath(root, env['ROLEEYE_DB_PATH'], path.join(dataDir, 'roleeye.db')),
  };
}

export function resolveEnvironment(root: string, env: NodeJS.ProcessEnv = process.env): Environment {
  const rawLevel = env['ROLEEYE_LOG_LEVEL']?.toLowerCase() ?? 'info';

  return {
    logLevel: isLogLevel(rawLevel) ? rawLevel : 'info',
    reasoningProvider: env['ROLEEYE_REASONING_PROVIDER'] ?? 'none',
    embeddingProvider: env['ROLEEYE_EMBEDDING_PROVIDER'] ?? 'none',
    paths: resolvePaths(root, env),
  };
}

/**
 * Walks up from a starting directory looking for a project marker so the CLI
 * works from any subdirectory.
 */
export function findProjectRoot(start: string = process.cwd()): string {
  let current = path.resolve(start);

  for (;;) {
    const hasMarker =
      existsSync(path.join(current, 'agent.md')) || existsSync(path.join(current, 'package.json'));
    if (hasMarker) return current;

    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}
